# Editing templates

A template is a stack of layers, drawn from the bottom up: a background, then perhaps glitter, a logo, the artist's name, and effects such as a glow over them. Anything can move with the music.

Click the pencil beside the list of templates to open the editor beside the picture. The templates that come with the app stay as they are: editing one makes a copy of your own. Every change shows on the picture at once, and is saved as you go.

![The template editor beside the picture](pictures/window-editor.png)

The editor has three tabs:

- **Layers**: the stack of layers, and the settings of the one selected.
- **Fields**: what someone using the template fills in. See [Fields and the About page](fields.md).
- **About**: who made the template and what it is.

**Done** closes the editor; **Export…** saves the template as a file to share. See [Sharing templates](sharing.md).

## The layers

The list shows the layers with the front one at the top, as in an image editor. Click one to select it; its settings appear below the list, and its [blend](blending-and-groups.md) and opacity above it.

- **Add a layer** with the **+** button, or Shift+⌘N (Shift+Ctrl+N). Type a few letters of its kind and press Return. It goes in front of the selected layer.
- **Hide a layer** with its eye.
- **Reorder** by dragging a layer up or down.
- **Rename** with a double-click.
- **Duplicate** (⌘J, Ctrl+J), **group** (⌘G, Ctrl+G) or **delete** (Backspace) the selected layer, or use the buttons under the list.

![The menu of layers, ready to search](pictures/add-layer.png)

There are layers that draw (a gradient, glitter, a picture, text, the spectrum…) and effects that change what is beneath them (a glow, a blur, a LUT…). Each is shown and described in [Layer types](layer-types.md).

## On the picture

Click the picture to select the layer there. Drag its outline to move it, or a corner to resize it; with Shift, it keeps its proportions.

## Settings

A layer's settings are the ones of its kind, then those every layer has: where it is and how big, its layer styles, and when it shows. See [Layer settings](layer-settings.md).

- Drag a number box sideways to change it; with Shift, in finer steps.
- The **∿** button beside a setting makes it [move with the music](formulas.md#moves-with).
- The **ƒ** button turns a setting into a [formula](formulas.md).

### Gradients

A gradient map's colours are shown as a bar above its settings, as in a photo editor. Drag a stop's marker to move it, click it to choose its colour, click the bar to add a stop there (five at most), or drag a marker away from the bar to take it out. Each stop is also an ordinary colour and position below the bar, so it can follow the music: a stop whose place follows a formula moves on the bar by itself, and is set below rather than dragged.

![A gradient map's stops on their bar](pictures/gradient-map.png)

The editor has its own undo while it is open: ⌘Z (Ctrl+Z) undoes changes to the template.

{{shortcuts: Editing a video template}}
