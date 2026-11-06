# Reach

## Who It's For

India runs some of the largest exams in the world. NEET-UG alone had over 2 million candidates in 2024, and its leak led to a Supreme Court case and a retest debate. Paper Seal is for the people around such an exam:

- **Candidates and parents**, who want to see the paper unlock on time and the same for everyone, without trusting the board's website.
- **Exam centres and neutral key holders**, who want proof their release was counted.
- **Journalists and courts**, who need a record of the unlock that the board can't edit or hide afterwards.

The unlock lasts minutes. That is exactly when a dishonest or overloaded board could let its own server go quiet. The Arkiv copy keeps the evidence visible and checkable in that window, and for 180 days after.

## Can They Try It Today

Yes. Run the verifier (`pnpm --filter @paperseal/verifier dev`) and open `#/exam/0x422205bde8135878ece4ccb921496e30076b32e14f48fb2886e3fa3f5181f295`. Set no storage and no TEE, and set `VITE_ARKIV_WRITERS=0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b`. Step 6 shows "8 of the 8 needed key holders have released. Read from the copy on Arkiv", with the Google token and the TEE signature both checked from Arkiv alone.

Four finished demo exams are mirrored now, at 2 entities each:

| Exam | Release log entity |
| --- | --- |
| `0x4222…f295` | [`0xc0a4…70a2`](https://rabdi.explorer.arkiv.network/entity/0xc0a486560fef7c07cee20e1d656706de53f763fa81f631f54589d022f0df70a2) |
| `0x5fba…77f7` | [`0x6c68…9001`](https://rabdi.explorer.arkiv.network/entity/0x6c68e35061a1b690e1bd94b8ac874aefff8dfc98f35515933660b1e487e79001) |
| `0xb59a…ece2` | [`0x6b14…47bc`](https://rabdi.explorer.arkiv.network/entity/0x6b1439a2260242d1d484612ef10857f2dab03f455cb3a54bf2b8658e96c147bc) |
| `0xe8a6…d212` | [`0x5068…ec84`](https://rabdi.explorer.arkiv.network/entity/0x5068de8588dee2f4134b48d2a7ea499e92b8dfb18806ff50aac93adeb301ec84) |

## After Mumbai

The mirror is part of Paper Seal's design, not a side demo. Every live exam runs `node relay/cli.mjs watch` during unlock. Next we plan to:

- mirror an index of exams;
- let neutral parties run their own relays and publish their writer addresses;
- move to Arkiv's mainnet once it exists.
