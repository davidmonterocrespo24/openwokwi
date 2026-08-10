# Component datasheets

Hand-authored Markdown shown in the Component Picker's hover panel
(`ComponentInfoPanel`). One file per component:

    component-docs/<category>/<id>.md

> Full authoring guide (with a per-component id checklist):
> [docs/wiki/component-datasheets.md](../../../../docs/wiki/component-datasheets.md)

- **`<id>` MUST match the component id** in `public/components-metadata.json`
  (the loader in `componentDocs.ts` matches by filename and ignores the
  category folder, so the folder is purely for tidiness).
- **`<category>`** — pick the closest `ComponentCategory`
  (`sensors`, `displays`, `input`, `output`, `motors`, `passive`, `logic`,
  `analog`, `electromech`, `boards`, `other`).
- **Keep it scannable.** The panel is a hover popover — a good doc is a
  one-line overview, a pinout table, a few spec bullets, and one wiring tip.
  The panel is scrollable, so longer datasheets are fine; front-load the
  essentials.
- **GitHub-flavoured Markdown** is supported (tables, lists, `` `code` ``,
  **bold**, links). Raw HTML is **not** rendered (react-markdown default).

## Front-matter (optional)

A doc may start with a small `---`-delimited block giving the component's
brand and a purchase link. Both are optional; when present the panel shows a
"by <brand>" line under the title and a **Buy** button in the footer.

```markdown
---
brand: Aosong (AM2302)
buy: https://www.example.com/product/dht22
---
Body markdown starts here…
```

- `brand` — manufacturer / brand name (plain text).
- `buy` — purchase URL. **Must be `http(s)://`** (other schemes are ignored
  for safety). The seeded docs use vendor *search* URLs as placeholders —
  swap them for the real product or affiliate link.

The panel already lists the live default **Properties** from metadata below
your doc, so don't repeat property defaults here — focus on what the JSON
can't express: how the part works, its pinout, wiring, and gotchas.

## Adding a doc

1. Create `component-docs/<category>/<id>.md`.
2. Write the overview + pinout + tips.
3. That's it — the file is picked up automatically (Vite `import.meta.glob`),
   loaded on first hover and cached. No registration needed.
