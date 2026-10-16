import assert from 'node:assert/strict';
import { test } from 'node:test';
import { depths, flatten, locate, treeOf } from '../src/visuals/layer-tree.ts';
import type { Layer } from '../src/visuals/template.ts';

const layer = (name: string): Layer => ({ type: 'text', name, params: {} });
const group = (name: string, size: number): Layer => ({ type: 'group', name, params: {}, size });
const names = (layers: Layer[]) => layers.map((l) => (l.size === undefined ? l.name : `${l.name}[${l.size}]`));

test('a list with groups is a tree, and back', () => {
  // Background, then a group of two with a group of one inside, then a top layer.
  const layers = [layer('bg'), group('outer', 3), layer('a'), group('inner', 1), layer('b'), layer('top')];
  const tree = treeOf(layers);
  assert.deepEqual(tree.map((n) => n.layer.name), ['bg', 'outer', 'top']);
  assert.deepEqual(tree[1].children!.map((n) => n.layer.name), ['a', 'inner']);
  assert.deepEqual(tree[1].children![1].children!.map((n) => n.layer.name), ['b']);
  assert.deepEqual(names(flatten(tree)), names(layers));
  assert.deepEqual(depths(layers), [0, 0, 1, 1, 2, 0]);
});

test('moving a layer into a group counts the group afresh', () => {
  const layers = [layer('bg'), group('g', 1), layer('a'), layer('top')];
  const tree = treeOf(layers);
  const top = locate(tree, layers[3])!;
  const [moved] = top.siblings.splice(top.index, 1);
  tree[1].children!.push(moved);
  assert.deepEqual(names(flatten(tree)), ['bg', 'g[2]', 'a', 'top']);
});

test('a group that claims more layers than there are gets those there are', () => {
  const layers = [layer('bg'), group('g', 9), layer('a')];
  assert.deepEqual(names(flatten(treeOf(layers))), ['bg', 'g[1]', 'a']);
  // A size on a layer that is no group means nothing.
  assert.deepEqual(names(flatten(treeOf([{ ...layer('x'), size: 3 }, layer('y')]))), ['x', 'y']);
});
