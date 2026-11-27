# Login shells (`bash -lc`, which Sail Boat runs) reach the user's systemd manager without a session.
if [ "$(id -u)" != 0 ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi
