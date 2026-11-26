---
title: Avatar
description: Connect a 2D avatar in VTube Studio or a 3D VRM avatar through a VMC app, and map the co-host's emotions to your model's expressions.
track: simple
verified: f126b94
---

# Avatar

By the end of this page the co-host will have a face on your stream: its mouth moves with its voice and its expression follows its mood. You choose between a 2D avatar and a 3D one.

The brain never knows which app you picked. It publishes one canonical picture of the avatar's state (mouth open, current emotion), and a small driver translates that for your app.

| `avatar.driver` | App | How it connects |
| --- | --- | --- |
| `vtube-studio` | [VTube Studio](../../start/glossary.md#vtube-studio) with a [Live2D](../../start/glossary.md#live2d) model (2D) | Through VTube Studio's own plugin connection |
| `vmc` | A 3D [VRM](../../start/glossary.md#vrm) avatar app that accepts the [VMC](../../start/glossary.md#vmc) protocol, such as VSeeFace, Warudo, VNyan or VMagicMirror | Through VMC, which carries the pose and expressions as small network messages |
| `browser` | A [VRM](../../start/glossary.md#vrm) model drawn in the dashboard's renderer page | Through the avatar-frame stream: the service writes the face's state each tick and the dashboard draws it. No host, port or plugin setting. |
| `null` | Nothing | No avatar app: the dashboard preview face is all there is. This is the default. Written as the string `"null"` in YAML. |

::: aside
A face is optional. A voice with no face is a podcast. A face with no voice is a mime. I recommend both.
:::

## What you need

- A [real install](../install/real-install.md) with the dashboard running.
- An avatar app with a model loaded: VTube Studio for 2D, or a VRM app for 3D.
- The avatar app's computer and the AI PC on the same network, if they are different machines.

## Steps: 2D with VTube Studio

1. In VTube Studio, open Settings, General, and turn on **Start API (allow plugins)**.

2. In `config/config.yaml`, choose the driver. `avatar.vtube_studio.host` and `avatar.vtube_studio.port` are where VTube Studio listens; the defaults already work for VTube Studio on the same machine as [Docker](../../start/glossary.md#docker), and `8001` is its default port:

   ```yaml
   avatar:
     driver: "vtube-studio"
     vtube_studio:
       host: "host.docker.internal"
       port: 8001
   ```

3. Restart the `avatar` service from the Services screen, or from a terminal:

   ```bash
   mise run cohostctl restart avatar
   ```

4. VTube Studio pops up an **Allow plugin** request. Click **Allow**. cohost saves the answer in `config/.vts-token`, so you will only be asked once.

5. Tell the co-host what your model's expressions are called. Open `config/expressions.yaml` and, under `vtube-studio`, set each emotion to the name of the hotkey that triggers it in VTube Studio (Settings, Hotkey Settings). Leave an emotion out to skip it. The emotions are `neutral`, `happy`, `laugh`, `surprised`, `smug`, `sad`, `angry`, `confused` and `think`. You can also name hotkeys for gestures, such as `wave`, under `gestures`.

## Steps: 3D with a VRM and VMC

1. In your VRM app, turn on a VMC receiver and note its port. cohost's default is `39539`.

2. In `config/config.yaml`:

   ```yaml
   avatar:
     driver: "vmc"
     vmc:
       host: "host.docker.internal"
       port: 39539
   ```

   If the app runs on another machine, put its address in `avatar.vmc.host`.

3. Restart the `avatar` service from the Services screen, or:

   ```bash
   mise run cohostctl restart avatar
   ```

4. Open `config/expressions.yaml` and, under `vmc`, set each emotion to the name of the VRM expression (blendshape) it should use. The defaults use the standard VRM presets, such as `Joy`, `Angry`, `Sorrow` and `Surprised`.

## Browser renderer

With `avatar.driver: "browser"` the service needs no app and no port. It writes the face's state (mouth, head, gaze, blink, emotion) on every tick to the avatar-frame stream, and the dashboard relays it to the renderer page, which draws the model. Nothing is opened on the [container](../../start/glossary.md#container) that runs the avatar service, and the model file never reaches it.

The dashboard tells the owner's own renderer pages from remote ones by the address they connect from: a page from this machine (any `127.x.y.z` address, `::1`, or `::ffff:127.x.y.z`) may report its model state, which the owner then sees, and a page from another machine may only draw. A router, port forward or proxy that makes a remote client arrive from this machine makes it look local and defeats that check, so do not put one in front of the dashboard's LAN port (3001). The check adds no setting.

On Windows with [WSL2](../../start/glossary.md#wsl2) there are two ways a forward does this. A `netsh interface portproxy` rule that listens on `localhost:3001` makes every LAN client arrive at the dashboard as `127.0.0.1`, so any of them can send model reports that the owner sees. A portproxy that targets the WSL VM's IP address makes every LAN page arrive from one address, so they all count against the two-page cap for a non-loopback address and only two can draw. Create no portproxy rule for the dashboard's ports.

```yaml
avatar:
  driver: "browser"
```

Under `browser` in `config/expressions.yaml`, each emotion names the VRM expression the page should show. The built-in names are the VRM 1.0 presets, so a model with the standard presets needs no block. An emotion you leave out takes the built-in name, and an empty string means no expression for that emotion. A name is at most 64 characters. `neutral` always shows no expression.

| Emotion | Built-in expression |
| --- | --- |
| `happy`, `laugh` | `happy` |
| `surprised` | `surprised` |
| `smug` | `relaxed` |
| `sad`, `confused` | `sad` |
| `angry` | `angry` |
| `think`, `neutral` | none |

The browser driver ignores `gestures`, because a VRM has no hotkeys.

### Choosing, previewing and framing a model

Pick the model and frame it on the Settings screen's Avatar page, in the **Avatar renderer** group. Upload a `.vrm` file there or copy it into the model store (see [Avatar models](../operate/dashboard.md#avatar-models)), choose its row, and the preview beside the list shows the choice before you save: it is the same page OBS loads, drawn in a frame over a checkerboard, so a transparent background shows as it will on stream. Save applies the model and framing to every open renderer page at once, and nothing restarts. Zoom, vertical position and turn move the model in the frame; Reset framing returns all three to their defaults.

Read the terms the model's author attaches before you stream it: cohost does not enforce them.

## Getting the avatar into OBS

The avatar app shows the model in its own window. To put it on stream, capture that window in [OBS](../../start/glossary.md#obs) as you would any other, if OBS runs on the same PC. If the avatar app runs on the AI PC and OBS runs on a second PC, send the avatar to OBS over NDI instead. [OBS and the voice on stream](obs.md) covers the other half, the voice.

## How you know it worked

- With VTube Studio: the **Allow plugin** request appeared once, you clicked Allow, and after the next reply the model's mouth moves in time with the voice.
- With VMC: the model's mouth and expression move after a reply. VMC is one-way fire-and-forget over the network, so cohost cannot tell you it is "connected". The movement is the proof.
- The Services screen shows `avatar` as `up`.
- Between lines, the avatar wears the co-host's current mood as its resting face.

## If it didn't

- **VTube Studio never asks you to Allow.** The API is not on, or `avatar.vtube_studio.host` or `avatar.vtube_studio.port` is wrong. Check Start API, then restart `avatar`.
- **The mouth moves but expressions do not.** The names in `config/expressions.yaml` do not match your model. VTube Studio matches hotkey names exactly.
- **Nothing moves with VMC.** Check the receiver is on, that the port matches `avatar.vmc.port`, and that no firewall blocks UDP between the machines.
- **VTube Studio is untested against a real app.** The VMC driver has been run against a network listener and VTube Studio only against a stand-in, so expect to adjust names on first contact.

More cases are on the [troubleshooting page](../troubleshooting.md).

## Next

Tune who the co-host is: [Personality](../tune/personality.md).
