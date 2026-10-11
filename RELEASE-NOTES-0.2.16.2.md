# Fulcra 0.2.16.2 (PC test build)

This is a test build for one Windows PC. It is not on main. Its changes go to main inside 0.2.17.

Fulcra 0.2.16.2 is 0.2.16.1 plus these changes:

- `fulcra ask` runs one model call on an account from the account pool, with no tools and no agent, workspace or session record. It prints JSON: `output`, `account`, `model` and `costUsd`. A usage limit marks the account limited, and the call moves once to the next usable account.
- `fulcra run --account <name>` pins a new session to a named pool account.
- A turn that ends on a usage-limit message marks the chat limited, with the limit kind and reset time. Reports to a limited lead are held until the reset. This state stays across a daemon restart.
- A lead gets one notice when one of its chats gets a new permission prompt. The sidebar shows "Waiting for permission".
