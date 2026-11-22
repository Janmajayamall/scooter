# ICU's zone rules, for the VM's Node

The four `.res` files are ICU's time zone rules for one release of the tz database, as the Unicode project publishes them for updating ICU: `https://github.com/unicode-org/icu-data`, under `tzdata/icunew/<release>/44/le/`, the format of ICU 44 and later, little-endian. `release.txt` names the release on its first line, and gives each file's SHA-256, as `sha256sum` writes it. `LICENSE` is that repository's licence, the Unicode License V3, which asks that its notice go with every copy of the files.

Each run gets a copy of this folder as `run/icu-tz/`, and pi's environment sets `ICU_TIMEZONE_FILES_DIR` to it, so every Node in the VM, `show` and pi, converts times with these rules instead of the image's own. Why, what `show` checks, and how to update them: [The zone rules](../../../../docs/architecture/agent.md#the-zone-rules).
