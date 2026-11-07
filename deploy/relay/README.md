# Relay on the Bee VM

Runs [`relay/`](../../relay) as systemd services on the Debian VM that already runs the Bee node and Caddy for the hackathon's read-only Swarm gateway ([`arkiv/swarm.md`](../../arkiv/swarm.md)). The relay signs with the board keystore, so it writes as `0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b`, the writer every reader already trusts.

```bash
VM=paperseal-swarm PROJECT_ID=<project> ZONE=asia-south1-a deploy/relay/install.sh
```

It installs Node 22, pnpm, cast and a clone of the repository at `/opt/paperseal`, and creates a `relay` user. The keystore goes in `/var/lib/paperseal-relay/.foundry/keystores/paperseal-board` and its password file in `/var/lib/paperseal-relay/.paperseal/`, both mode 600 and owned by `relay`. Settings are in `/etc/paperseal-relay.env` ([`relay.env`](relay.env)), and a re-run keeps them.

| Unit | Runs | When |
| --- | --- | --- |
| `paperseal-relay-index` | `index --every 60` from the registry's deploy block | Always, restarted on failure |
| `paperseal-relay-watch@<examId>` | `watch` against storage and the TEE, with heartbeats | Start it before an exam's unlock. It stops by itself once the TEE says released |
| `paperseal-relay-mirror@<examId>` | `mirror` from public storage | Once, after an exam is released |
| `paperseal-relay-backup@<examId>` | `backup` through the local Bee node (`127.0.0.1:1633`) and `SWARM_BATCH` | After the Build, and again after unlock |

```bash
sudo systemctl start paperseal-relay-watch@<examId>
sudo journalctl -u 'paperseal-relay-*' -f
```

The VM holds the board's key while this runs. It is a testnet wallet for the demo. A real board uses a dedicated writer address (`relay/README.md`, "Safety") and adds it to `paperseal.arkiv-writers`.
