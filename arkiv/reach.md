# Reach

## Who It's For

India runs some of the world's largest exams. NEET-UG alone had over 2 million candidates in 2024, and its paper leak went to the Supreme Court and led to calls for a retest. Paper Seal is for the people around exams like that:

- **Students and parents**, who want to see the paper unlock on time and the same for everyone, without trusting the board's website.
- **Exam centres and key holders**, who want proof their release was counted.
- **Journalists and courts**, who need a record of the unlock that the board can't change or hide.

The unlock lasts minutes. That is exactly when a dishonest or overloaded board could let its server go quiet. The Arkiv copy keeps the record visible in that window, and for 180 days after.

## Can They Try It Today

Yes. Open the [public verifier](https://paperverify.abdulrashid.dev/#/exam/0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3). To see Arkiv alone, clear "Where the public files are kept" and "Live machine address" under "Check it yourself", and save. Step 6 still shows "8 of the 8 needed key holders have released. Read from the copy on Arkiv".

To run it locally, after `pnpm install` put this in `apps/verifier/.env.local`. Storage and the TEE are left out on purpose, so the board's servers play no part:

```bash
VITE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
VITE_REGISTRY_ADDRESS=0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb
VITE_TEE_STORAGE_BUCKET=paperseal-demo-paperseal-exams
VITE_ARKIV_WRITERS=0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b
```

Then run `pnpm --filter @paperseal/verifier dev` and open `http://localhost:5172/#/exam/0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3`.

**What's on Arkiv now.** Six finished demo exams, each with its signed release log and Google token. Two are on the current registry `0xc25F…58eb`. The other four are on an older demo registry, `0x6a9f…dBE8`, which the current verifier no longer reads.

| Exam | Release log entity |
| --- | --- |
| `0x83b3…c4c3` | [`0x9caa…a901`](https://rabdi.explorer.arkiv.network/entity/0x9caa1e8a77d4d31332f13f24e4cd22af6cee9b052615e500aec4e1b1d151a901) |
| `0x1d12…6e79` | [`0x46fa…2fc3`](https://rabdi.explorer.arkiv.network/entity/0x46fac433f14dcaae8cb72b1b8575259e2accc145fdd67a34e0a92ac6c1c32fc3) |
| `0x4222…f295` | [`0xc0a4…70a2`](https://rabdi.explorer.arkiv.network/entity/0xc0a486560fef7c07cee20e1d656706de53f763fa81f631f54589d022f0df70a2) |
| `0x5fba…77f7` | [`0x6c68…9001`](https://rabdi.explorer.arkiv.network/entity/0x6c68e35061a1b690e1bd94b8ac874aefff8dfc98f35515933660b1e487e79001) |
| `0xb59a…ece2` | [`0x6b14…47bc`](https://rabdi.explorer.arkiv.network/entity/0x6b1439a2260242d1d484612ef10857f2dab03f455cb3a54bf2b8658e96c147bc) |
| `0xe8a6…d212` | [`0x5068…ec84`](https://rabdi.explorer.arkiv.network/entity/0x5068de8588dee2f4134b48d2a7ea499e92b8dfb18806ff50aac93adeb301ec84) |

**The exam list is live too:** 22 exams from the current registry and 10 from the older one, with over 100 approved people. Open [`#/exams`](https://paperverify.abdulrashid.dev/#/exams) to browse them, or search for `centre-1` under "Find exams by person". Without this list, nobody could browse a board's exams without running their own indexer.

## After Mumbai

The Arkiv copy is part of Paper Seal's design, not a side demo. For a live exam, the relay runs `node relay/cli.mjs watch` during unlock, which writes each new signed copy and a heartbeat every minute. It now runs as a service on our VM ([`deploy/relay`](../deploy/relay)), writing as the board's wallet. Next we plan to:

- let neutral parties run their own relays and publish their writer addresses;
- move to Arkiv's mainnet once it exists.
