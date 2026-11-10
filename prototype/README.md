# Ephemeral text prototype

Standalone UX experiment for the Whisper Echo display. It has no backend: the text is a simulated
feed of made-up sentences. Text is never saved. Display settings (colors, size, motion, dust, feed speed) are
remembered in the browser's `localStorage` per `CLAUDE.md`; **Reset all** forgets them. If storage is blocked, the
prototype still works and just doesn't remember. `&light=1` ignores saved settings.

## Run
Open `prototype/index.html` in a browser (double-click it). No server needed.

## What it does
- Large type; words arrive at the bottom and every line scrolls up slowly. New lines start below the old ones.
  If text arrives faster than the scroll speed, the scroll speeds up smoothly so new text stays on screen.
- Above the **pixelate-from** line (default: window middle) a line is progressively pixelated.
- When a line's middle crosses the **dust zone** near the top it breaks into pixel blocks that split into
  grains, drift up and sideways, shrink and fade. Once its grains are gone, the text no longer exists anywhere.

## Settings menu
Move the mouse to the **right edge** of the window (or press `M`; `Esc` closes). It hides again when the mouse leaves.
`Space` pauses the feed. The cursor hides after a few idle seconds.
- **Theme:** Dark / Light presets (initial choice follows the system setting), plus free **text** and **background** color pickers.
- **Display:** text size, left/center alignment.
- **Motion:** scroll speed, where pixelation starts, max pixel size, how far from the top the dust zone starts.
- **Dust:** wind (negative blows left), lift, grain lifetime, how long a line takes to break up.
- **Feed:** words per second, pause, clear text, reset all.

## Files
| File | Purpose |
|---|---|
| `index.html` | Canvas + hidden settings panel |
| `style.css` | Theme variables, panel styling |
| `app.js` | Line layout, scrolling, pixelation, dust particles, menu logic |
| `feed.js` | Simulated word feed (replace with WebSocket messages in the real UI) |

## Test parameters
`?warp=30` pre-simulates 30 s before the first frame, `&menu=1` opens the menu, `&light=1` forces the light theme.

## Relationship to the real app
The real UI in `wwwroot/` is this prototype's display engine with the simulated feed replaced by the
microphone + `/ws` client (`client.js`), partial-text tail replacement, retention-based expiry, and an
intro phrase. This folder is kept as a standalone sandbox for tuning the look.
