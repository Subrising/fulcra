// The host owns its daemon lifecycle. Never start a second daemon.
throw Error("Enable Command Centre in the Fulcra host; standalone daemon lifecycle is unsupported");
