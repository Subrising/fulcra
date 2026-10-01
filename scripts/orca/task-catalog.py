"""Atomic task edits under an OS lock, released automatically if the process dies."""
import fcntl
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import uuid


def private_file(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Task files must be private regular files owned by this user.")


def read(file):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        private_file(stream.fileno())
        if os.fstat(stream.fileno()).st_size > 1048576:
            raise ValueError("Task file exceeds the size limit.")
        return json.load(stream)


def text(value, limit):
    """Catalog strings are counted in UTF-16 code units, as the reader counts them."""
    return isinstance(value, str) and value.strip() and len(value.encode("utf-16-le", "surrogatepass")) // 2 <= limit


def update(request):
    home = Path(request["home"])
    file = home / "tasks.json"
    # Keep the inode: unlinking a lock can let two processes lock different files.
    fd = os.open(str(file) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        private_file(lock.fileno())
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another task command is updating this home; retry when it finishes.") from None
        config, catalog = read(home / "config.json"), read(file)
        action, value = request["action"], request.get("value")
        issues, authority = catalog["issues"], config["authority"]
        if action == "add":
            if not isinstance(value, str) or not value.strip() or len(value.encode("utf-16-le", "surrogatepass")) // 2 > 160 or len(issues) >= 1000:
                raise ValueError("Task title required (1–160 characters); maximum 1000 tasks.")
            parent = request.get("parent") or authority["programmeId"]
            if not any(row["id"] == parent and row["status"] in ("todo", "in_progress") for row in issues):
                raise ValueError("Active parent project/task required.")
            parent_row = next(row for row in issues if row["id"] == parent)
            # Membership is written explicitly and inherited only from the parent's own
            # registered project. Nothing is inferred from a title, and no existing row
            # is rewritten.
            inherited = parent_row.get("projectId")
            row = {"id": str(uuid.uuid4()), "companyId": authority["companyId"], "parentId": parent,
                   "identifier": f"ORCA-{len(issues)}", "title": value.strip(), "status": "todo",
                   "assigneeUserId": "local-board", "assigneeAgentId": None,
                   "projectId": inherited if isinstance(inherited, str) else None}
            issues.append(row)
        elif action == "project-add":
            # A project is a registered catalog row, not a renamed task. Creating one also
            # creates its anchor task, because admission ancestry still runs through tasks.
            projects = catalog.setdefault("projects", [])
            if not isinstance(projects, list):
                raise ValueError("Existing projects catalog is not a list; inspect tasks.json.")
            if not text(value, 160):
                raise ValueError("Project name required (1–160 characters).")
            description = request.get("description")
            if description is not None and not text(description, 2000):
                raise ValueError("Project description must be 1–2000 characters, or omitted.")
            if len(projects) >= 64:
                raise ValueError("Maximum 64 projects.")
            if len(issues) >= 1000:
                raise ValueError("Maximum 1000 tasks.")
            taken = {row.get("id") for row in issues} | {row.get("id") for row in projects if isinstance(row, dict)}
            project_id = str(uuid.uuid4())
            while project_id in taken:
                project_id = str(uuid.uuid4())
            project = {"id": project_id, "companyId": authority["companyId"], "name": value.strip(),
                       "description": description.strip() if isinstance(description, str) else None,
                       "status": "active"}
            projects.append(project)
            anchor = {"id": str(uuid.uuid4()), "companyId": authority["companyId"],
                      "parentId": authority["programmeId"], "identifier": f"ORCA-{len(issues)}",
                      "title": value.strip(), "status": "todo", "assigneeUserId": "local-board",
                      "assigneeAgentId": None, "projectId": project_id}
            if anchor["id"] == project_id:
                raise ValueError("Generated identifiers collided; retry the command.")
            issues.append(anchor)
            row = {"project": project, "task": anchor}
        elif action in ("close", "reopen"):
            row = next((row for row in issues if row["id"] == value), None)
            if row is None or row["id"] == authority["programmeId"]:
                raise ValueError("Existing non-root task required.")
            row["status"] = "done" if action == "close" else "in_progress"
        else:
            raise ValueError(
                "Use task add TITLE [PARENT_UUID], close UUID, reopen UUID, or project add NAME [DESCRIPTION]."
            )
        data = json.dumps(catalog, indent=2) + "\n"
        if len(data.encode("utf-8")) > 1048576:
            raise ValueError("Task catalog would exceed its size limit; existing tasks are unchanged.")
        fd, temporary = tempfile.mkstemp(prefix="tasks-", suffix=".tmp", dir=home)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return row


if __name__ == "__main__":
    try:
        print(json.dumps(update(json.load(sys.stdin))))
    except (ValueError, KeyError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
