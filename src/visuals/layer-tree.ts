// Groups of layers. A template keeps its layers as one list, in drawing order
// (the back first), so that everything that knows a layer by its place in it
// (what was drawn where, what a layer remembers from frame to frame, the
// editor's selection) works the same with groups as without. A group is a
// layer of the kind `group` whose `size` says how many of the layers right
// after it are inside it, groups within it and their layers included.
//
// To change what is in which group, the list is made into a tree and back.

import type { Layer } from './template.ts';

export interface LayerNode {
  layer: Layer;
  /** For a group, what is in it, the back first. */
  children?: LayerNode[];
}

export const isGroup = (layer: Layer) => layer.type === 'group';

/** The list as a tree. A group that claims more layers than there are gets those there are. */
export function treeOf(layers: Layer[]): LayerNode[] {
  let at = 0;
  const take = (end: number): LayerNode[] => {
    const nodes: LayerNode[] = [];
    while (at < end) {
      const layer = layers[at++];
      if (isGroup(layer)) {
        const inside = Math.max(0, Math.min(Math.floor(layer.size ?? 0), end - at));
        nodes.push({ layer, children: take(at + inside) });
      } else {
        nodes.push({ layer });
      }
    }
    return nodes;
  };
  return take(layers.length);
}

/** The tree as a list again, each group's size counted afresh. */
export function flatten(nodes: LayerNode[]): Layer[] {
  const out: Layer[] = [];
  const walk = (list: LayerNode[]) => {
    for (const node of list) {
      out.push(node.layer);
      if (node.children) {
        const start = out.length;
        walk(node.children);
        node.layer.size = out.length - start;
      } else {
        delete node.layer.size;
      }
    }
  };
  walk(nodes);
  return out;
}

/** Where a layer is in the tree: the list it is in, and its place there. */
export function locate(nodes: LayerNode[], layer: Layer): { siblings: LayerNode[]; index: number; parent: LayerNode | null } | null {
  const search = (list: LayerNode[], parent: LayerNode | null): ReturnType<typeof locate> => {
    for (let index = 0; index < list.length; index++) {
      if (list[index].layer === layer) return { siblings: list, index, parent };
      const inside = list[index].children ? search(list[index].children!, list[index]) : null;
      if (inside) return inside;
    }
    return null;
  };
  return search(nodes, null);
}

/** Whether `inner` is `outer` or inside it, however deep. */
export function within(outer: LayerNode, inner: Layer): boolean {
  return outer.layer === inner || (outer.children ?? []).some((child) => within(child, inner));
}

/** How deep in groups each layer of the list is: 0 for one in no group. */
export function depths(layers: Layer[]): number[] {
  const out: number[] = [];
  const walk = (list: LayerNode[], depth: number) => {
    for (const node of list) {
      out.push(depth);
      if (node.children) walk(node.children, depth + 1);
    }
  };
  walk(treeOf(layers), 0);
  return out;
}
