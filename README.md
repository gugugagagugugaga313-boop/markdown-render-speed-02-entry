# markdown-render-speed-02-entry

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/gugugagagugugaga313-boop/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/gugugagagugugaga313-boop/markdown-render-speed-02-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown renderer written from scratch for speed. `parse.js`
exports a single `parse(markdown)` function that returns exactly the HTML
marked 18.1.3 produces with its default options (GFM on), byte for byte, on
every CommonMark 0.31.2 spec example, every GFM 0.29 extension example, and
long generated documents — while rendering the whole set measurably faster
than marked itself by scanning with plain character loops, building strings
with joins, and skipping work for plain text.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=output node main.ts
```

This reads `input/cases.json`, renders every case with `parse.js`, and writes
`output/html.json` in the same shape.

---

<sub>Entered on [make.fun](https://make.fun/?ref=g9rrka13&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
