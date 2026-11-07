# Paper Seal presentation

Plain HTML deck, no build. `POINTS.md` is the agreed list of points the deck follows.

```bash
python3 -m http.server 5180 --directory presentation
```

Open http://localhost:5180. Arrow keys or clicks move between slides, and printing to PDF gives a handout. The deck is being rebuilt page by page in the paper style (see `paperkit.html`). Each slide animates when it appears, and pressing `r` replays it. The old 19-slide placeholder deck is in git history.

Keys: arrows, space or click to move. `r` replays the page. `f` toggles full screen. Add `?static` to the address to see every page finished, with no animation.
Videos: a demo clip opens full screen and starts by itself. `v`, `Esc` or a click on it shrinks it into the taped frame, and `v` or a click fills the screen again. `k` pauses or plays it.
