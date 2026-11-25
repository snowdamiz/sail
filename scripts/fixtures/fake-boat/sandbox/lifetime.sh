# Powers the sandbox off once the deadline the host wrote (Unix seconds) has passed, as Boat does.
deadline=/var/lib/fake-boat/readonly/deadline
while sleep 1; do
  at=$(cat "$deadline" 2>/dev/null) || continue
  [ -n "$at" ] && [ "$(date +%s)" -ge "$at" ] && exec systemctl poweroff
done
