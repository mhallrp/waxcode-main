# The browser UI

React + TypeScript. This is the interface to a Waxcode box — there is no other one.

```sh
npm install
npm run dev                      # against waxcodedvs.local
VITE_BOX=http://192.168.1.87 npm run dev
npm run build                    # writes into ../server/web/
npm run deploy 192.168.1.87      # build + copy onto a running box
npm run check                    # types, design tokens, and tests
npm test                         # tests alone
```

## How it reaches a box

The box **serves static files and never builds** — there is no `npm install` anywhere in its
provisioning or its updater. So the build output is committed, exactly like the generated design
tokens are.

`npm run build` writes into `../server/web/`. That has two consequences worth knowing:

* **Deploying to your own box** is `npm run deploy`, which builds and copies those files into
  whatever release the box is currently running (it reads `releases/current`, so it cannot deploy
  into a release that has been superseded).
* **Shipping to someone else's box** needs nothing new. `tools/package-release.js` copies `server/`
  wholesale into the release tarball, so these files ride along on their own.

Because it is committed, it can fall behind the source it came from. `npm run check:bundle`
rebuilds and fails if that happened, and `tools/package-release.js` runs the same check before it
will publish anything - a release shipping an old UI against a new server is the failure this
prevents.

Filenames are deliberately **not** content-hashed. The output is committed, so stable names keep
the diffs readable, and caching is irrelevant — the box sends `Cache-Control: no-cache` anyway.

## Layout

Atomic design, and the rule is one-directional: **a thing may only import from the layer below it.**

| Layer | Knows about | Example |
|---|---|---|
| `components/atoms` | Nothing. One element, one job. | `Button`, `TextField`, `Label` |
| `components/molecules` | Atoms only. | `Field` (label + input + error), `RevealField` |
| `components/organisms` | Atoms and molecules. Still no API calls. | `Rail`, `Notice`, `SavedNetworkList` |
| `screens` | Everything, plus `lib/api`. Where data is fetched and decisions are made. | `Settings/NetworkPane` |

If a component needs to know what a `NetworkState` is, it belongs in `screens`, not in `organisms`.
That is the whole test.

Styling is the `css()` helper in `styles/css.ts`: a component declares its rules **in its own
file** (`const styles = css('Button', { button: '...' })`), and they are injected as a `<style>`
element at module evaluation, with hashed class names so they cannot collide. There is no global
stylesheet beyond `styles/global.css`, which holds only resets and values shared by more than one
component.

`--accent` is deliberately **not** generated. `tokens.css` says what the colours are; `global.css`
says what they are for, and `--accent` is rebound per deck (in `DeckCard.tsx`) so deck 1 is
teal and deck 2 amber without anything inside the card knowing which deck it is drawing.

## Design tokens

`src/styles/tokens.css` and `tokens.ts` are **generated** by `../tools/generate-design-tokens.mjs`
— do not edit them by hand. Re-run with `npm run tokens`.

## Deliberately absent

* **Dragging the waveform to scrub.** Tapping the overview seeks. Dragging the zoomed view needs
  rubber-banding and momentum, which is a piece of work in its own right.
* **BPM measured from platter speed.** The displayed BPM is the track's own tag scaled by the
  platter, not a measurement of the platter itself.

## Three things that fail silently, and the checks for them

`npm run check` runs the type checker, `scripts/check-tokens.mjs` and the tests.

**A React render that throws** abandons everything after it, silently. `App.dom.test.tsx` mounts
the whole app against a stubbed box and uses it, which is the only thing that catches that.

**A missing design token** is dropped and the element renders with whatever it inherited, which
usually looks plausible — three invented names got through in the first hour here and none of them
looked broken on screen. That is what `check-tokens.mjs` is for.

**Signed bytes read as unsigned** still draw a plausible waveform. `lib/waveform.ts` and its tests
exist for that class of thing: the decode, the averaging, the integer truncation, and the run-in's
bar phase.
