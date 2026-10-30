# Dry Bones Live — Halloween Garage Projection

A 2-minute seamless animation loop built around Ezekiel 37 ("Rattle!" theme): scattered dry bones rattle,
come together bone to bone, rise, and dance, with resurrection scriptures (KJV) on screen.

## Files

| File | Use it when |
|---|---|
| `dry-bones-loop-1080p.mp4` | Playing from a media player, USB stick, Fire TV/Roku, or a projector's built-in player. Set the player to **Repeat/Loop**. |
| `dry-bones-loop.html` | Playing from a laptop. Open in Chrome/Edge, click once for fullscreen. Loops forever on its own. |

## Story timeline (repeats every 120 s)

| Time | On screen | Scripture |
|---|---|---|
| 0:00 | Valley of scattered bones | Ezekiel 37:3 |
| 0:08 | Bones begin to rattle | Ezekiel 37:4 |
| 0:19 | Bones fly together, bone to bone | Ezekiel 37:7 |
| 0:30 | Breath swirls in, eyes light, skeletons stand | Ezekiel 37:10 |
| 0:35–1:52 | The army dances (5 rotating moves) | 2 Kings 13:21, Isaiah 26:19, John 11:25, John 5:25, Romans 8:11, Ephesians 2:5, 1 Corinthians 15:52, Matthew 28:6 |
| 1:52 | Bones collapse back to the ground (and the loop restarts) | 1 Corinthians 15:55 |

## Projector setup (garage door)

1. **Placement:** Projector on a table or ladder in the driveway, centered on the door. Distance depends on the
   projector's throw ratio; most budget projectors fill a 16 ft door from about 12–16 ft back.
2. **Black = no light.** The background is pure black, so the door shows only glowing bones. Turn off porch and
   garage lights near the door for best contrast. Projection looks best after dusk.
3. **Keystone:** If the projector is below the door's center, use keystone correction to square the image.
4. **Power and weather:** Use an outdoor-rated extension cord. Keep the projector covered if dew or rain is possible.
5. **Screen savers:** On a laptop, disable sleep/screen-off (Windows: Settings → System → Power).

## Adding the song "Rattle!"

The song is copyrighted, so it isn't embedded in the video. Two options:

- **Simplest:** Play "Rattle!" from Spotify, Apple Music, or YouTube Music on a Bluetooth speaker set to repeat. The
  animation loop doesn't need to sync to the song.
- **Baked in (personal use only):** If you've purchased the track (e.g., `rattle.mp3`), combine it with:

  ```bash
  ffmpeg -stream_loop -1 -i dry-bones-loop-1080p.mp4 -i rattle.mp3 -shortest -c:v copy -c:a aac -b:a 192k dry-bones-with-rattle.mp4
  ```

  This produces a video the length of the song. Don't post that version publicly (YouTube, Facebook); it'll be
  flagged for copyright.

## Customizing

Edit `dry-bones-loop.html`:
- `VERSES` — change wording, references, or timing.
- `BPM` — dance tempo (default 120).
- `SKELETONS` — positions, sizes, number of skeletons.
- `BONE`, `GOLD` — colors.

To re-render the MP4 after edits, use a headless browser to step `window.renderAt(t)` frame by frame and pipe to
ffmpeg (or simply screen-record the HTML playing fullscreen with OBS).
