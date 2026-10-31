# Dry Bones Live — Halloween Garage Projection

A 7:12 seamless animation loop timed to Elevation Worship's "Rattle!" (76 BPM). One skeleton comes to life first, the
rest join one by one, a fire builds behind them, they nod together, dance wild, dance in unison with flowers, and finally
rise up into beams of light. Resurrection scriptures (KJV) run the whole way through.

## Files

| File | Use it when |
|---|---|
| `dry-bones-loop.html` | Browser on the iPad (Safari). Starts on its own and repeats forever; tap anytime to restart from 0:00. Never interrupts Spotify. |
| `dry-bones-rattle-7m12s-1080p.mp4` | iPad video player, media player, USB stick, Fire TV/Roku, or a projector's built-in player. Set the player to **Repeat**. |

## Story timeline (repeats every 7:12)

| Time | On screen | Scripture |
|---|---|---|
| 0:00 | Fade in on a valley of scattered bones | Ezekiel 37:3 |
| 0:08 | The center skeleton's bones rattle | Ezekiel 37:4 |
| 0:19 | Its bones fly together, bone to bone | Ezekiel 37:7 |
| 0:30 | Breath swirls in, eyes light, the first skeleton stands and dances | Ezekiel 37:5 |
| 0:35–2:51 | Another skeleton rises every 17 seconds; two of them bob their heads to the beat | Ezekiel 37:14, 2 Kings 13:21, Isaiah 26:19, John 11:25, John 5:25, Luke 15:24 |
| 1:48 | Fire builds in the background, drifting embers like the breath | Acts 2:3, Romans 8:11, Ephesians 2:5, Psalm 30:11, Psalm 149:3, Ezekiel 37:10 |
| 3:00–3:08 | Everyone slows down and nods their heads together | Psalm 46:10 |
| 3:08–5:15 | Each skeleton works up to its own wild dance; fire burns brighter | 2 Samuel 6:14, 1 Corinthians 15:52, Revelation 1:18, Psalm 150:4, Hosea 13:14, Matthew 28:6, Jeremiah 20:9, 1 Corinthians 15:57, Romans 6:4, Ezekiel 37:6, Isaiah 61:3 |
| 5:19–5:29 | Everyone hits the "whoa" together, snapping side to side on the beat | Psalm 16:11 |
| 5:29–6:45 | All dance the same moves together holding flowers; flowers sprout around them and petals float | Song of Solomon 2:12, Isaiah 35:1, Psalm 133:1, Ephesians 4:4, Isaiah 40:8, 1 Corinthians 15:55 |
| 6:45–7:06 | A beam of light comes down on each skeleton; arms raised, its bones rise into the light | 1 Thessalonians 4:16–17, Revelation 21:4 |
| 7:06–7:12 | Fade to black, ready to restart | |

## iPad Pro + Spotify setup

1. **Connect to the projector:** USB-C to HDMI adapter (or Apple TV AirPlay mirroring). The iPad mirrors its screen.
2. **Stop the screen from sleeping:** Settings → Display & Brightness → Auto-Lock → **Never**.
3. **Spotify:** Open "Rattle!", turn on **Repeat One** (tap repeat twice until it shows a "1"). Play the audio through a
   Bluetooth speaker, or through the projector if it has speakers.
4. **The bones:** Open `dry-bones-loop.html` (or the claude.ai link) in Safari. It starts playing and repeats on its own.
5. **Sync (optional):** Restart the song from 0:00 in Spotify, switch to Safari, and tap the screen. The bones restart from 0:00, and the wild part
   lines up with the song. Spotify keeps playing because the page makes no sound.
6. **Optional, keeps guests from swiping away:** Settings → Accessibility → Guided Access → On, then triple-click the top
   button in Safari.

Spotify adds a small gap when it repeats, so after a few hours the two can drift a few seconds. If they drift, tap the screen
at the start of the song to restart the bones.

Why not the MP4 on iPad? Playing a video in Photos can pause Spotify. The web page has no audio, so Spotify keeps playing.

## Projector placement (garage door)

1. **Placement:** Center the projector on the door. Most budget projectors fill a 16 ft door from about 12–16 ft back.
2. **Black means no light.** The background is pure black, so only the bones show on the door. Turn off porch and garage
   lights near the door, and wait until dusk.
3. **Keystone:** If the projector sits below the door's center, use keystone correction to square the image.
4. **Power and weather:** Use an outdoor-rated extension cord, and cover the projector if dew or rain is possible.

## Song and copyright

The song isn't embedded in the video. Play it from Spotify. If you've bought the MP3 and want it baked in for personal
use:

```bash
ffmpeg -i dry-bones-rattle-7m12s-1080p.mp4 -i rattle.mp3 -shortest -c:v copy -c:a aac -b:a 192k dry-bones-with-rattle.mp4
```

Don't post that version publicly; YouTube and Facebook will flag it.

## Customizing

Edit `dry-bones-loop.html`:
- `VERSES`: wording, references, timing.
- `T_FIRE0`, `T_NOD0`, `T_WHOA`, `T_TOGETHER`, `T_ASC`: when the fire, nodding, whoa, flower dance, and rising begin.
- `SONG_BPM`: tempo for head nods (76 for "Rattle!").
- `s.listener`: which skeletons bob their heads.
- `SKELETONS`, `BONE`, `GOLD`: positions, sizes, colors.
