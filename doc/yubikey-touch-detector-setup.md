# Setting up yubikey-touch-detector

Start from the [upstream README](https://github.com/max-baz/yubikey-touch-detector) and
its [wiki](https://github.com/max-baz/yubikey-touch-detector/wiki) for installation and
general configuration. The notes below cover the extra steps needed to make the DBus
interface and SSH detection work reliably under GNOME/Wayland with gpg-agent.

## Run the detector with DBus enabled

The extension subscribes to the detector's DBus interface. Start it with:

```
yubikey-touch-detector --dbus
```

For a persistent setup, use a systemd user unit anchored to the graphical session:

```ini
[Unit]
Description=YubiKey Touch Detector
After=graphical-session.target gpg-agent.socket
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=/usr/local/bin/yubikey-touch-detector --dbus
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

## SSH socket: make sure the detector wraps the right socket

The detector intercepts SSH auth by proxying `$SSH_AUTH_SOCK`. On GNOME, the systemd
user manager inherits `SSH_AUTH_SOCK` from the session autostart (often pointing to
gnome-keyring), while shells may resolve a different socket (gpg-agent's). If these
diverge, SSH touches are silently missed.

Fix: pin `SSH_AUTH_SOCK` for the whole user session. In
`~/.config/environment.d/10-gpg-ssh.conf`:

```
SSH_AUTH_SOCK=${XDG_RUNTIME_DIR}/gnupg/S.gpg-agent.ssh
```

Then disable gnome-keyring's SSH component so it no longer overrides the variable at
startup (`~/.config/autostart/gnome-keyring-ssh.desktop` with `Hidden=true`).

See the [wiki](https://github.com/max-baz/yubikey-touch-detector/wiki) for details on
each detection method (GPG, U2F, HMAC, SSH) and their requirements.
