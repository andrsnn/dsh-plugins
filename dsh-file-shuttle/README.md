# dsh-file-shuttle

Lets the model hand files to the user as download links.

- `send_files` publishes files or directories. More than one path is zipped
  on the fly. It returns a link on the tailnet (MagicDNS name, else the 100.x
  IP), the LAN, and loopback. Links expire after 60 minutes by default
  (`expiryMinutes`, max 20160).
- `shuttle_status` shows the server, lists active links, and purges them.

One background server (`server.mjs`) on port 8931 serves every link. It starts
detached on first use and is reused across tool calls, sessions, and DSH
restarts. Published files are copied into `~/.dsh/file-shuttle/outbox`, so the
originals are never served in place. `/publish`, `/links`, and `/purge` accept
loopback only. The 128-bit token in each link is the only secret.

Install it into a `dsh` profile like the other plugins here (see the
top-level README).

```sh
node test.mjs
```
