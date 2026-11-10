# Kaunta — developer handoff

Everything Claude Code (or a developer) needs to build Kaunta from the designs.

```
CLAUDE.md               ← start here: instructions, non-negotiables, stack, build order, tests
docs/product-spec.md    users, principles, visual direction, screen list
docs/domain-rules.md    data model + every business rule with IDs (R-SELL-1 …)
docs/screens.md         per-screen spec: states, data, actions, acceptance criteria
design/README.md        how to read the design files
design/tokens.css       CSS variables, Night + Day themes
design/tokens.json      tokens, type scale, touch sizes, status→icon/label, icon paths
design/screens/*.dc.html  source of all 29 artboards (visual reference)
i18n/en.json, sw.json   319 strings, same keys, matching {placeholders}
data/seed.json          consistent sample data (Baraka Pub, one business day)
```

## Using it with Claude Code

```bash
mkdir kaunta && cd kaunta
unzip ~/Downloads/kaunta-handoff.zip -d .
git init && git add . && git commit -m "Design handoff"
claude
```

Then a good first prompt:

> Read CLAUDE.md and the docs folder. Set up the project with the suggested stack, then do step 1 of the build order (tokens, theme switch, i18n loader, formatKES, StatusChip, SyncPill) with tests. Match design/screens/Components.dc.html.

Work through the build order one step per session; ask Claude Code to check each screen against its `.dc.html` file and the acceptance criteria in `docs/screens.md`.
