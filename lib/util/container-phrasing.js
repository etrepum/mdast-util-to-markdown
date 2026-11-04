/**
 * @import {Attention, Handle, Info, State, Tracker} from 'mdast-util-to-markdown'
 * @import {PhrasingParents} from '../types.js'
 */

import {asciiPunctuation} from 'micromark-util-character'
import {classifyCharacter} from 'micromark-util-classify-character'
import {firstCharacter, lastCharacter} from './character.js'
import {encodeCharacterReference} from './encode-character-reference.js'
import {encodeInfo} from './encode-info.js'
import {htmlKind} from './html-kind.js'

/**
 * Markers for builtin attention (emphasis, strong) to whether they are stricter:
 * whether they cannot open and close inside words.
 *
 * Builtin runs pair following CommonMark rules for emphasis and strong:
 * they are split,
 * using one or two markers at a time,
 * with the rule of 3.
 * Other markers pair like GFM strikethrough:
 * whole runs pair with a run of the same size.
 *
 * @type {Map<string, boolean>}
 */
const builtins = new Map([
  ['*', false],
  ['_', true]
])

/**
 * @typedef AttentionResult
 *   Attention, of which the sequence is chosen later.
 * @property {Array<Item>} children
 *   Serialized children.
 * @property {Array<string>} sequences
 *   Sequences that can be used, in order of preference.
 */

/**
 * @typedef Cursor
 *   Where pairing runs of a marker is.
 * @property {number} count
 *   Runs paired since the last snapshot.
 * @property {number} index
 *   Token.
 * @property {Snapshot | undefined} state
 *   Snapshot at `index`, if kept.
 */

/**
 * @typedef {AttentionResult | string} Item
 *   Serialized phrasing.
 */

/**
 * @typedef Pairing
 *   State of pairing runs of a marker like `micromark`.
 * @property {Array<Run>} pending
 *   Runs that can open, in order.
 * @property {Map<number, Array<number>>} wrong
 *   Sequences that do not (yet) form their attention,
 *   with the sequences involved.
 */

/**
 * @typedef Run
 *   Sequences next to each other with the same marker.
 * @property {boolean} close
 *   Whether it can close.
 * @property {number} end
 *   Index after the last marker not used (to open).
 * @property {Array<number>} markers
 *   Token index of the sequence of each marker.
 * @property {boolean} open
 *   Whether it can open.
 * @property {boolean} split
 *   Whether it can be split (built-in attention).
 * @property {number} start
 *   Index of the first marker not used (to close).
 * @property {Array<number>} tokens
 *   Token indices of the sequences.
 */

/**
 * @typedef Node
 *   Item, as rendered.
 *   How a node renders depends only on the nodes next to it,
 *   its first and last child, and its parent,
 *   so changing the sequence of attention only renders those again.
 * @property {number} close
 *   Token of the closing sequence of attention.
 * @property {boolean} closeInside
 *   Whether attention encodes the character before its closing sequence.
 * @property {boolean} closeOutside
 *   Whether attention encodes the character after it.
 * @property {string | undefined} encodeAfter
 *   Character to encode if a string starts with it, before the node.
 * @property {Node | undefined} first
 *   First child of attention.
 * @property {string} head
 *   Value of a string before its parent encodes it.
 * @property {Item} item
 *   Item.
 * @property {Node | undefined} last
 *   Last child of attention.
 * @property {Node | undefined} next
 *   Next node.
 * @property {number} open
 *   Token of a string, or of the opening sequence of attention.
 * @property {boolean} openInside
 *   Whether attention encodes the character after its opening sequence.
 * @property {boolean} openOutside
 *   Whether attention encodes the character before it.
 * @property {string} outsideAfter
 *   Character after attention.
 * @property {Node | undefined} parent
 *   Parent attention.
 * @property {Node | undefined} previous
 *   Previous node.
 * @property {boolean} queued
 *   Whether the node is queued to render again.
 * @property {string} sequence
 *   Sequence of attention.
 * @property {string} start
 *   Value of a string after encoding its start for attention before it.
 */

/**
 * @typedef Serialization
 *   State of serializing phrasing with attention:
 *   nodes (strings and attention) rendered to tokens (strings, and the
 *   opening and closing sequence of attention).
 * @property {string} after
 *   Characters after.
 * @property {Array<AttentionResult | undefined>} attentions
 *   Attention of each token, if it is a sequence.
 * @property {string} before
 *   Characters before.
 * @property {Array<number>} changed
 *   Tokens changed by a try.
 * @property {boolean} hollow
 *   Whether there is attention without content, which never forms.
 * @property {Array<Array<number> | undefined>} involved
 *   Sequences involved with each sequence that does not form its attention.
 * @property {Array<number>} knowns
 *   Index up to which pairing is known, for each marker.
 * @property {Array<unknown> | undefined} log
 *   Changes made by a try, to undo them: object, key, and old value.
 * @property {Array<string>} markers
 *   Markers that sequences can use.
 *   Runs of different markers do not affect each other,
 *   so each pairs on its own.
 * @property {Map<AttentionResult, Node>} nodes
 *   Node of each attention.
 * @property {Array<Node>} queue
 *   Nodes to render again.
 * @property {Array<Array<Snapshot | undefined>>} snapshots
 *   State of pairing before some tokens that are not in the middle of a
 *   run, for each marker.
 * @property {Array<string>} values
 *   Value of each token.
 * @property {Uint8Array} wrongs
 *   Whether each token is a sequence that does not form its attention.
 */

/**
 * @typedef {string} Snapshot
 *   State of pairing at a token, as JSON:
 *   for each run that can open, its `start`, `end`, `open`, `close`, `split`,
 *   `markers`,
 *   and the sequences involved with each of its sequences, if wrong.
 */

/**
 * @typedef Token
 *   Rendered phrasing.
 * @property {AttentionResult | undefined} attention
 *   Attention, if this is one of its sequences.
 * @property {string} value
 *   Value.
 */

/**
 * Get candidates for a mistake:
 * attention to try other sequences for,
 * later first.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Array<number>} involved
 *   Sequences involved in the mistake.
 * @returns {Array<AttentionResult>}
 *   Candidates.
 */
function candidates(serialization, involved) {
  const {attentions, nodes, values} = serialization
  /** @type {Set<AttentionResult>} */
  const found = new Set()
  /** @type {Set<AttentionResult>} */
  const related = new Set()
  /** @type {Set<number>} */
  const seen = new Set()

  for (const at of involved) {
    found.add(/** @type {AttentionResult} */ (attentions[at]))
  }

  // The attention involved, and attention in runs with its sequences.
  for (const attention of found) {
    const node = /** @type {Node} */ (nodes.get(attention))

    for (const at of [node.open, node.close]) {
      // Each run once.
      if (seen.has(at)) continue
      const marker = values[at].charAt(0)
      let start = at
      let end = at + 1
      while (start > 0 && isMarker(serialization, start - 1, marker)) start--
      while (end < values.length && isMarker(serialization, end, marker)) end++

      while (start < end) {
        seen.add(start)
        related.add(/** @type {AttentionResult} */ (attentions[start++]))
      }
    }
  }

  // Later first: attention that opens later is inner or next.
  return [...related].sort(
    (a, b) =>
      /** @type {Node} */ (nodes.get(b)).open -
      /** @type {Node} */ (nodes.get(a)).open
  )
}

/**
 * Check whether sequences form their attention, like `micromark`.
 *
 * Sequences of `*` and `_` pair like emphasis and strong in CommonMark,
 * others like strikethrough in GFM.
 * This continues from where pairing is known,
 * until the first sequence that does not is known,
 * and keeps the state of pairing before each run,
 * so that a try can pair again from there.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} from
 *   Index to find the first mistake from.
 * @returns {number}
 *   First sequence that does not form its attention, or `-1`.
 */
function check(serialization, from) {
  const {knowns, markers, snapshots, values, wrongs} = serialization
  const length = values.length
  /** @type {Array<Cursor>} */
  const cursors = []
  /** @type {Array<Pairing>} */
  const pairings = []
  let first = from

  for (const [lane, index] of knowns.entries()) {
    const state = /** @type {Snapshot} */ (snapshots[lane][index])
    cursors.push({count: 0, index, state})
    pairings.push(restore(state))
  }

  /**
   * Note whether a sequence forms its attention.
   *
   * @param {number} at
   *   Token.
   * @param {Array<number> | undefined} list
   *   Sequences involved, if wrong.
   * @returns {undefined}
   *   Nothing.
   */
  function decide(at, list) {
    record(serialization, at, list)
  }

  while (true) {
    // Sequences before `frontier` are done pairing, for every marker.
    let frontier = length
    let behind = -1
    let lane = -1

    while (++lane < markers.length) {
      const bound = Math.min(knowns[lane], undone(pairings[lane]))

      if (!(bound < frontier)) {
        continue
      }

      frontier = bound
      behind = lane
    }

    while (first < frontier && wrongs[first] === 0) first++
    if (first < frontier || behind === -1) break

    // Pair further for the marker that is behind.
    const cursor = cursors[behind]
    advance(serialization, behind, pairings[behind], cursor, decide)
    snapshots[behind][cursor.index] = cursor.state
    knowns[behind] = cursor.index
  }

  // Keep the state where pairing is known.
  for (const [lane, pairing] of pairings.entries()) {
    snapshots[lane][knowns[lane]] ||= snapshot(pairing)
  }

  return first < length ? first : -1
}

/**
 * Serialize the children of a parent that contains phrasing children.
 *
 * @param {PhrasingParents} parent
 *   Parent of phrasing nodes.
 * @param {State} state
 *   Info passed around about the current state.
 * @param {Info} info
 *   Info on where we are in the document we are generating.
 * @returns {string}
 *   Serialized result.
 */
export function containerPhrasing(parent, state, info) {
  return serialize(phrasing(parent, state, info), info.before, info.after)
}

/**
 * Encode the first or last character of a string as a character reference.
 *
 * @param {Token} token
 *   String token.
 * @param {boolean} start
 *   Whether to encode the first or last character.
 * @returns {undefined}
 *   Nothing.
 */
function encode(token, start) {
  const character = start
    ? firstCharacter(token.value)
    : lastCharacter(token.value)
  const reference = encodeCharacterReference(
    /** @type {number} */ (character.codePointAt(0))
  )

  if (start) {
    token.value = reference + token.value.slice(character.length)
  } else {
    let value = token.value.slice(0, token.value.length - character.length)
    let escapes = 0

    while (value.charCodeAt(value.length - 1 - escapes) === 92 /* `\` */) {
      escapes++
    }

    // Odd number would escape the `&` again.
    if (escapes % 2) value += '\\'
    token.value = value + reference
  }
}

/**
 * Try other sequences for the candidates of a mistake and use the first that
 * moves the mistake further.
 *
 * @param {Serialization} serialization
 *   State, changed if better.
 * @param {number} mistake
 *   Index of the first sequence that does not form its attention.
 * @returns {boolean}
 *   Whether that worked.
 */
function improve(serialization, mistake) {
  for (const attention of candidates(
    serialization,
    /** @type {Array<number>} */ (serialization.involved[mistake])
  )) {
    const current = /** @type {Node} */ (serialization.nodes.get(attention))
      .sequence

    for (const sequence of attention.sequences) {
      if (
        sequence !== current &&
        attempt(serialization, attention, sequence, mistake)
      ) {
        return true
      }
    }
  }

  return false
}

/**
 * Try a sequence for attention, and keep it if it moves the mistake further.
 *
 * Only the nodes around the attention are rendered again,
 * and runs are paired again from the state before the first changed token,
 * until the state of pairing is as it was before.
 *
 * @param {Serialization} serialization
 *   State, changed if better.
 * @param {AttentionResult} attention
 *   Attention.
 * @param {string} sequence
 *   Sequence to try.
 * @param {number} mistake
 *   Index of the mistake.
 * @returns {boolean}
 *   Whether that is better.
 */
function attempt(serialization, attention, sequence, mistake) {
  const {knowns, markers, snapshots, values} = serialization
  const length = values.length
  const node = /** @type {Node} */ (serialization.nodes.get(attention))
  serialization.log = []
  serialization.changed = []
  write(serialization, node, 'sequence', sequence)

  for (const other of [
    node,
    node.previous,
    node.next,
    node.first,
    node.last,
    node.parent
  ]) {
    enqueue(serialization, other)
  }

  settle(serialization)

  const changed = [...new Set(serialization.changed)].sort((a, b) => a - b)
  let formed = false
  let worse = false

  /**
   * Note whether a sequence forms its attention.
   *
   * @param {number} at
   *   Token.
   * @param {Array<number> | undefined} list
   *   Sequences involved, if wrong.
   * @returns {undefined}
   *   Nothing.
   */
  function decide(at, list) {
    record(serialization, at, list)
    if (list && at <= mistake) worse = true
    if (at === mistake && !list) formed = true
  }

  let lane = -1

  while (++lane < markers.length && !worse) {
    const known = knowns[lane]
    const states = snapshots[lane]
    let next = 0

    while (next < changed.length && changed[next] <= known && !worse) {
      // Start where pairing is known, before the token before the change,
      // as that decides whether the run after it can open or close.
      let index = Math.max(changed[next] - 1, 0)
      while (index > 0 && states[index] === undefined) index--
      const from = index
      /** @type {Cursor} */
      const cursor = {count: 0, index, state: states[index]}
      const pairing = restore(/** @type {Snapshot} */ (cursor.state))

      while (!worse) {
        index = cursor.index
        while (next < changed.length && changed[next] < index - 1) next++

        if (index > from) {
          const old = states[index]

          // Where pairing is as before, and the tokens around are as before,
          // the rest pairs as before until the next change.
          // Sequences up to the mistake that are still open then are done
          // pairing before `known`, as `check` found the mistake.
          if (
            index <= known &&
            (next === changed.length || changed[next] > index) &&
            old === snapshot(pairing)
          ) {
            break
          }

          // Stop once sequences up to the mistake are done pairing.
          if (
            index === length ||
            (index > mistake && undone(pairing) > mistake)
          ) {
            write(
              serialization,
              states,
              index,
              cursor.state || snapshot(pairing)
            )
            write(serialization, knowns, lane, index)
            next = changed.length
            break
          }

          write(serialization, states, index, cursor.state)
        }

        advance(serialization, lane, pairing, cursor, decide)
      }
    }
  }

  const log = /** @type {Array<unknown>} */ (serialization.log)
  serialization.log = undefined

  // Better if the mistake now forms, and nothing before it does not.
  if (worse || !formed) {
    let index = log.length

    while (index > 0) {
      index -= 3
      const object = /** @type {Record<PropertyKey, unknown>} */ (log[index])
      object[/** @type {PropertyKey} */ (log[index + 1])] = log[index + 2]
    }

    return false
  }

  return true
}

/**
 * Pair a run like `micromark` with the runs before it that can open,
 * and mark sequences that do form their attention as fine.
 *
 * Each pair uses markers from the end of an opener and the start of a closer.
 * It forms the intended attention if those markers are exactly the whole
 * opening and closing sequence of one attention.
 * Otherwise attention is mixed up:
 * either sequences of different attention pair,
 * part of a sequence is used (such as `**` of strong as `*`),
 * or several sequences are used together (such as `*` and `*` as `**`).
 * Then the sequences involved are recorded with each other.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Pairing} pairing
 *   State of pairing, changed.
 * @param {Run} closer
 *   Run.
 * @param {(at: number, list: Array<number> | undefined) => undefined} decide
 *   Called with each sequence of an opener that is used up.
 * @returns {undefined}
 *   Nothing.
 */
function pair(serialization, pairing, closer, decide) {
  const {attentions, values} = serialization
  const {pending, wrong} = pairing
  let open = closer.close ? pending.length : 0

  while (open-- && closer.start < closer.end) {
    const opener = pending[open]
    const openerSize = opener.end - opener.start
    const closerSize = closer.end - closer.start

    if (
      closer.split
        ? // The rule of 3, on the sizes that are left.
          (opener.close || closer.open) &&
          closerSize % 3 &&
          !((openerSize + closerSize) % 3)
        : // Others pair whole runs of the same size.
          openerSize !== opener.markers.length || openerSize !== closerSize
    ) {
      continue
    }

    const size = closer.split
      ? openerSize > 1 && closerSize > 1
        ? 2
        : 1
      : closerSize
    const opening = opener.markers.slice(opener.end - size, opener.end)
    const closing = closer.markers.slice(closer.start, closer.start + size)
    const openAt = opening[0]
    const closeAt = closing[0]
    const involved = [...new Set([...opening, ...closing])]

    if (
      // Whole sequences:
      // the markers of a sequence are next to each other,
      // so if the first and last marker are of one sequence of that size,
      // all markers are exactly that sequence.
      openAt === opening[size - 1] &&
      values[openAt].length === size &&
      closeAt === closing[size - 1] &&
      values[closeAt].length === size &&
      // Of the same attention, so its opening and closing sequence.
      attentions[openAt] === attentions[closeAt]
    ) {
      wrong.delete(openAt)
      wrong.delete(closeAt)
    } else {
      // Add to what is involved already: a sequence can be in several pairs.
      for (const at of involved) {
        const list = wrong.get(at)
        if (list) for (const other of involved) list.push(other)
      }
    }

    opener.end -= size
    closer.start += size

    // A sequence is done once all its markers are used.
    for (const at of involved) {
      const run = at < closeAt ? opener : closer

      if (!(
        run.start < run.end &&
        run.markers[run.start] <= at &&
        at <= run.markers[run.end - 1]
      )) {
        decide(at, wrong.get(at))
      }
    }

    if (opener.start === opener.end) pending.splice(open, 1)

    // Search again from the start, as this run may close more.
    open = pending.length
  }
}

/**
 * Get the sequences that can be used for attention, in order of preference.
 *
 * @param {string} type
 *   Node type.
 * @param {Array<string>} markers
 *   Markers.
 * @param {Array<number>} sizes
 *   Sizes.
 * @returns {Array<string>}
 *   Sequences.
 */
function attentionSequences(type, markers, sizes) {
  if (markers.length === 0) {
    throw new Error(
      'Cannot serialize `' +
        type +
        '` as attention without markers, expected one or more markers'
    )
  }

  if (sizes.length === 0) {
    throw new Error(
      'Cannot serialize `' +
        type +
        '` as attention without sizes, expected one or more sizes'
    )
  }

  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error(
        'Cannot serialize `' +
          type +
          '` as attention with `' +
          size +
          '` as size, expected positive integer'
      )
    }
  }

  /** @type {Array<string>} */
  const sequences = []

  for (const marker of markers) {
    if (marker.length !== 1) {
      throw new Error(
        'Cannot serialize `' +
          type +
          '` as attention with `' +
          marker +
          '` as marker, expected a single ascii character'
      )
    }

    if (!asciiPunctuation(marker.charCodeAt(0))) {
      throw new Error(
        'Cannot serialize `' +
          type +
          '` as attention with `' +
          marker +
          '` as marker, expected ascii punctuation'
      )
    }

    for (const size of sizes) {
      sequences.push(marker.repeat(size))
    }
  }

  return sequences
}

/**
 * Serialize the children of a parent that contains phrasing children,
 * keeping attention separate,
 * so that its markers can be chosen later.
 *
 * @param {PhrasingParents} parent
 *   Parent of phrasing nodes.
 * @param {State} state
 *   Info passed around about the current state.
 * @param {Info} info
 *   Info on where we are in the document we are generating.
 * @returns {Array<Item>}
 *   Items.
 */
function phrasing(parent, state, info) {
  const indexStack = state.indexStack
  const children = parent.children || []
  /** @type {Array<Item>} */
  const results = []
  let index = -1
  let before = info.before

  indexStack.push(-1)
  let tracker = state.createTracker(info)

  while (++index < children.length) {
    const child = children[index]
    /** @type {string} */
    let after

    indexStack[indexStack.length - 1] = index

    if (index + 1 < children.length) {
      /** @type {Handle} */
      // @ts-expect-error: hush, it’s actually a `zwitch`.
      let handle = state.handle.handlers[children[index + 1].type]
      // @ts-expect-error: hush, it’s actually a `zwitch`.
      if (handle && handle.peek) handle = handle.peek
      after = handle
        ? firstCharacter(
            handle(children[index + 1], parent, state, {
              before: '',
              after: '',
              ...tracker.current()
            })
          )
        : ''
    } else {
      after = info.after
    }

    // In some cases, html (text) can be found in phrasing right after an eol.
    // When we’d serialize that, it could be seen as html (flow): all its kinds
    // except 7 can interrupt a paragraph.
    // As we can’t escape or so to prevent it from happening,
    // we take a somewhat reasonable approach:
    // replace that eol with a space.
    // See: <https://github.com/syntax-tree/mdast-util-to-markdown/issues/15>
    const previous = results[results.length - 1]

    if (
      typeof previous === 'string' &&
      (before === '\r' || before === '\n') &&
      child.type === 'html' &&
      htmlKind(child.value) !== 7
    ) {
      results[results.length - 1] = previous.replace(/(\r?\n|\r)$/, ' ')
      before = ' '

      // To do: does this work to reset tracker?
      tracker = state.createTracker(info)
      tracker.move(serialize(results, info.before, info.after))
    }

    /** @type {(Handle & {attention?: Attention | undefined}) | undefined} */
    // @ts-expect-error: hush, it’s actually a `zwitch`.
    const handle = state.handle.handlers[child.type]

    if (handle && handle.attention) {
      const item = attentionItem(
        /** @type {PhrasingParents} */ (child),
        handle.attention,
        state,
        tracker
      )
      results.push(item)
      before = lastCharacter(item.sequences[0])
    } else {
      const value = state.handle(child, parent, state, {
        ...tracker.current(),
        after,
        before
      })

      if (!value) continue
      tracker.move(value)
      results.push(value)
      before = lastCharacter(value)
    }
  }

  indexStack.pop()

  return results
}

/**
 * Serialize a node as attention,
 * with its sequence chosen later.
 *
 * @param {PhrasingParents} node
 *   Node.
 * @param {Attention} attention
 *   Attention of the node.
 * @param {State} state
 *   Info passed around about the current state.
 * @param {Tracker} tracker
 *   Tracker.
 * @returns {AttentionResult}
 *   Attention.
 */
export function attentionItem(node, attention, state, tracker) {
  const {construct, markers, sizes} = attention(node, state)
  const sequences = attentionSequences(node.type, markers, sizes)
  const sequence = sequences[0]
  const exit = state.enter(construct)
  tracker.move(sequence)
  const children = phrasing(node, state, {
    ...tracker.current(),
    before: sequence,
    after: sequence
  })
  tracker.move(serialize(children, sequence, sequence))
  tracker.move(sequence)
  exit()
  return {children, sequences}
}

/**
 * Lay out and render items with their preferred sequences;
 * encoding characters around attention where needed.
 *
 * @param {Array<Item>} items
 *   Serialized phrasing.
 * @param {string} before
 *   Characters before.
 * @param {string} after
 *   Characters after.
 * @returns {Serialization}
 *   State.
 */
function render(items, before, after) {
  /** @type {Serialization} */
  const serialization = {
    after,
    attentions: [],
    before,
    changed: [],
    hollow: false,
    involved: [],
    knowns: [],
    log: undefined,
    markers: [],
    nodes: new Map(),
    queue: [],
    snapshots: [],
    values: [],
    wrongs: new Uint8Array(0)
  }

  place(serialization, items, undefined)
  serialization.wrongs = new Uint8Array(serialization.values.length)

  for (const _ of serialization.markers) {
    serialization.knowns.push(0)
    serialization.snapshots.push([snapshot({pending: [], wrong: new Map()})])
  }

  settle(serialization)
  return serialization
}

/**
 * Add nodes for items.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Array<Item>} items
 *   Items.
 * @param {Node | undefined} parent
 *   Parent attention.
 * @returns {undefined}
 *   Nothing.
 */
function place(serialization, items, parent) {
  const {attentions, values} = serialization
  /** @type {Node | undefined} */
  let previous

  for (const item of items) {
    const sequence = typeof item === 'string' ? '' : item.sequences[0]
    /** @type {Node} */
    const node = {
      close: values.length,
      closeInside: false,
      closeOutside: false,
      encodeAfter: undefined,
      first: undefined,
      head: '',
      item,
      last: undefined,
      next: undefined,
      open: values.length,
      openInside: false,
      openOutside: false,
      outsideAfter: '',
      parent,
      previous,
      queued: false,
      sequence,
      start: ''
    }
    enqueue(serialization, node)
    if (previous) previous.next = node
    else if (parent) parent.first = node
    previous = node

    if (typeof item === 'string') {
      values.push(item)
      attentions.push(undefined)
    } else {
      if (item.children.length === 0) serialization.hollow = true

      for (const option of item.sequences) {
        const marker = option.charAt(0)
        if (!serialization.markers.includes(marker)) {
          serialization.markers.push(marker)
        }
      }

      serialization.nodes.set(item, node)
      values.push(sequence)
      attentions.push(item)
      place(serialization, item.children, node)
      node.close = values.length
      values.push(sequence)
      attentions.push(item)
    }
  }

  if (parent) parent.last = previous
}

/**
 * Serialize phrasing with attention.
 *
 * Whether attention forms depends on everything around it.
 * This checks that it does and tries other sequences if not:
 * for the first mistake,
 * it tries other sequences for the attention involved,
 * and uses the first that moves the mistake further.
 *
 * @param {Array<Item>} items
 *   Phrasing items.
 * @param {string} before
 *   Characters before.
 * @param {string} after
 *   Characters after.
 * @returns {string}
 *   Serialized markdown.
 */
export function serialize(items, before, after) {
  // Without attention, there is nothing to pair.
  if (items.every((item) => typeof item === 'string')) {
    return join(/** @type {Array<string>} */ (items))
  }

  const serialization = render(items, before, after)
  const initial = join(serialization.values)

  // Attention without content never forms.
  if (serialization.hollow) return initial

  let mistake = check(serialization, 0)

  while (mistake !== -1) {
    if (!improve(serialization, mistake)) return initial
    // Mistakes only move further.
    mistake = check(serialization, mistake + 1)
  }

  return join(serialization.values)
}

/**
 * Pair the run at a token, if it is one of a marker,
 * or move past the token.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} lane
 *   Marker.
 * @param {Pairing} pairing
 *   State of pairing, changed.
 * @param {Cursor} cursor
 *   Where pairing is, changed.
 * @param {(at: number, list: Array<number> | undefined) => undefined} decide
 *   Called with each sequence that is done pairing.
 * @returns {undefined}
 *   Nothing.
 */
function advance(serialization, lane, pairing, cursor, decide) {
  const states = serialization.snapshots[lane]

  if (isMarker(serialization, cursor.index, serialization.markers[lane])) {
    const end = step(serialization, pairing, cursor.index, decide)

    while (++cursor.index < end) {
      write(serialization, states, cursor.index, undefined)
    }

    // A snapshot takes as long as the runs that can open,
    // so keep one once as many runs paired.
    cursor.state = undefined

    if (++cursor.count >= pairing.pending.length) {
      cursor.count = 0
      cursor.state = snapshot(pairing)
    }
  } else {
    cursor.index++
  }

  // At the end, what is still open does not form.
  if (cursor.index === serialization.values.length) {
    for (const run of pairing.pending) done(pairing, run, decide)
    pairing.pending = []
    cursor.state = snapshot(pairing)
  }
}

/**
 * Note that the sequences of a run are done pairing.
 *
 * @param {Pairing} pairing
 *   State of pairing, changed.
 * @param {Run} run
 *   Run.
 * @param {(at: number, list: Array<number> | undefined) => undefined} decide
 *   Called with each sequence.
 * @returns {undefined}
 *   Nothing.
 */
function done(pairing, run, decide) {
  for (const token of run.tokens) decide(token, pairing.wrong.get(token))
}

/**
 * Render a node again later.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Node | undefined} node
 *   Node.
 * @returns {undefined}
 *   Nothing.
 */
function enqueue(serialization, node) {
  if (node && !node.queued) {
    node.queued = true
    serialization.queue.push(node)
  }
}

/**
 * Check whether a token is a sequence of a marker.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} at
 *   Token.
 * @param {string} marker
 *   Marker.
 * @returns {boolean}
 *   Whether it is.
 */
function isMarker(serialization, at, marker) {
  return (
    serialization.attentions[at] !== undefined &&
    serialization.values[at].charAt(0) === marker
  )
}

/**
 * Join values.
 *
 * @param {Array<string>} values
 *   Values.
 * @returns {string}
 *   Value.
 */
function join(values) {
  let result = ''
  for (const value of values) result += value
  return result
}

/**
 * Note whether a sequence forms its attention.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} at
 *   Token.
 * @param {Array<number> | undefined} list
 *   Sequences involved, if wrong.
 * @returns {undefined}
 *   Nothing.
 */
function record(serialization, at, list) {
  write(serialization, serialization.wrongs, at, list ? 1 : 0)
  write(serialization, serialization.involved, at, list)
}

/**
 * Get the state of pairing of a snapshot.
 *
 * @param {Snapshot} state
 *   Snapshot.
 * @returns {Pairing}
 *   State of pairing.
 */
function restore(state) {
  /** @type {Pairing} */
  const pairing = {pending: [], wrong: new Map()}
  /** @type {Array<[number, number, boolean, boolean, boolean, Array<number>, Array<Array<number> | null>]>} */
  const runs = JSON.parse(state)

  for (const [start, end, open, close, split, markers, lists] of runs) {
    const tokens = [...new Set(markers)]
    pairing.pending.push({close, end, markers, open, split, start, tokens})

    for (const [index, list] of lists.entries()) {
      if (list) pairing.wrong.set(tokens[index], list)
    }
  }

  return pairing
}

/**
 * Render queued nodes again until nothing changes.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @returns {undefined}
 *   Nothing.
 */
function settle(serialization) {
  const queue = serialization.queue
  let index = -1

  while (++index < queue.length) {
    queue[index].queued = false
    update(serialization, queue[index])
  }

  queue.length = 0
}

/**
 * Get a snapshot of the state of pairing.
 *
 * @param {Pairing} pairing
 *   State of pairing.
 * @returns {Snapshot}
 *   Snapshot.
 */
function snapshot(pairing) {
  if (pairing.pending.length === 0) return '[]'
  return JSON.stringify(
    pairing.pending.map((run) => [
      run.start,
      run.end,
      run.open,
      run.close,
      run.split,
      run.markers,
      run.tokens.map((at) => pairing.wrong.get(at))
    ])
  )
}

/**
 * Pair the run that starts at a token.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Pairing} pairing
 *   State of pairing, changed.
 * @param {number} index
 *   First sequence of the run.
 * @param {(at: number, list: Array<number> | undefined) => undefined} decide
 *   Called with each sequence that is done pairing.
 * @returns {number}
 *   Index after the run.
 */
function step(serialization, pairing, index, decide) {
  const {after, before, values} = serialization
  const marker = values[index].charAt(0)
  const strict = builtins.get(marker)
  let end = index + 1

  while (end < values.length && isMarker(serialization, end, marker)) {
    end++
  }

  const head = index ? values[index - 1] : before
  const previous = classifyCharacter(head.charCodeAt(head.length - 1))
  const next = classifyCharacter(
    (end < values.length ? values[end] : after).charCodeAt(0)
  )
  const open = !next || (next === 2 && Boolean(previous))
  const close = !previous || (previous === 2 && Boolean(next))
  /** @type {Run} */
  const run = {
    tokens: [],
    markers: [],
    start: 0,
    end: 0,
    // Underscores are strict, they cannot open or close inside words.
    open: strict ? open && (Boolean(previous) || !close) : open,
    close: strict ? close && (Boolean(next) || !open) : close,
    // All builtins can split runs.
    split: strict !== undefined
  }

  for (let at = index; at < end; at++) run.tokens.push(at)

  for (const at of run.tokens) {
    // Every sequence is wrong until it pairs with its other sequence.
    pairing.wrong.set(at, [...run.tokens])
    let size = values[at].length
    while (size--) run.markers.push(at)
  }

  run.end = run.markers.length
  pair(serialization, pairing, run, decide)

  if (run.open && run.start < run.end) {
    pairing.pending.push(run)
  } else {
    done(pairing, run, decide)
  }

  return end
}

/**
 * Get the first sequence that is not done pairing:
 * the sequence of the first marker that is not used of the first run that
 * can still open.
 *
 * @param {Pairing} pairing
 *   State of pairing.
 * @returns {number}
 *   Token, or `Infinity`.
 */
function undone(pairing) {
  const run = pairing.pending[0]
  return run ? run.markers[run.start] : Infinity
}

/**
 * Render a node again,
 * and queue the nodes that depend on what changed.
 *
 * This does what rendering items in order does:
 * a string encodes its first character if attention before it asks so,
 * attention decides whether to encode characters around its sequences from
 * the characters around them,
 * and then encodes the last character of a string before it,
 * and the first and last character of its content.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Node} node
 *   Node.
 * @returns {undefined}
 *   Nothing.
 */
function update(serialization, node) {
  const {first, item, last, next, parent, previous: before} = node
  /** @type {string | undefined} */
  let encodeAfter

  if (before && typeof before.item !== 'string') {
    encodeAfter = before.closeOutside ? before.outsideAfter : before.encodeAfter
  }

  if (write(serialization, node, 'encodeAfter', encodeAfter)) {
    enqueue(serialization, next)
  }

  if (typeof item === 'string') {
    /** @type {Token} */
    const token = {attention: undefined, value: item}

    // If attention before had to encode the character after it, encode it.
    if (encodeAfter && encodeAfter === firstCharacter(item)) {
      encode(token, true)
    }

    const start = token.value

    if (next && next.openOutside) {
      const outside = lastCharacter(start)
      if (outside !== '\n' && outside !== '\r') encode(token, false)
    }

    const head = token.value
    if (parent && parent.first === node && parent.openInside)
      encode(token, true)
    if (parent && parent.last === node && parent.closeInside)
      encode(token, false)
    if (write(serialization, node, 'start', start)) enqueue(serialization, next)

    if (
      write(serialization, node, 'head', head) &&
      parent &&
      (parent.first === node || parent.last === node)
    ) {
      enqueue(serialization, parent)
    }

    write(serialization, serialization.values, node.open, token.value)
    return
  }

  const {sequence} = node
  const marker = sequence.charAt(0)
  const previous = before
    ? typeof before.item === 'string'
      ? lastCharacter(before.start)
      : before.sequence.charAt(before.sequence.length - 1)
    : lastCharacter(parent ? parent.sequence : serialization.before)
  const outsideAfter = firstCharacter(
    next
      ? typeof next.item === 'string'
        ? next.item
        : next.sequence
      : parent
        ? parent.sequence
        : serialization.after
  )
  const head = first
    ? typeof first.item === 'string'
      ? first.head
      : first.sequence
    : ''
  const open = encodeInfo(
    previous.charCodeAt(previous.length - 1),
    head.charCodeAt(0),
    marker
  )
  /** @type {Token} */
  const inside = {
    attention: undefined,
    value: last
      ? typeof last.item === 'string'
        ? last.head
        : last.sequence
      : ''
  }

  if (
    open.inside &&
    last === first &&
    last &&
    typeof last.item === 'string' &&
    // Not rendered yet.
    inside.value
  ) {
    encode(inside, true)
  }

  const tail = lastCharacter(inside.value)
  const close = encodeInfo(
    outsideAfter.charCodeAt(0),
    tail.charCodeAt(tail.length - 1),
    marker
  )

  if (write(serialization, node, 'openInside', open.inside)) {
    enqueue(serialization, first)
  }

  if (write(serialization, node, 'openOutside', open.outside)) {
    enqueue(serialization, before)
  }

  if (write(serialization, node, 'closeInside', close.inside)) {
    enqueue(serialization, last)
  }

  const movedClose = write(serialization, node, 'closeOutside', close.outside)
  const movedAfter = write(serialization, node, 'outsideAfter', outsideAfter)
  if (movedClose || movedAfter) enqueue(serialization, next)
  write(serialization, serialization.values, node.open, sequence)
  write(serialization, serialization.values, node.close, sequence)
}

/**
 * Set a field, logging the change while trying.
 *
 * @template {PropertyKey} K
 *   Key.
 * @template T
 *   Value.
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Record<K, T>} object
 *   Object, changed.
 * @param {K} key
 *   Key.
 * @param {T} value
 *   Value.
 * @returns {boolean}
 *   Whether it changed.
 */
function write(serialization, object, key, value) {
  if (object[key] === value) return false

  if (serialization.log) {
    serialization.log.push(object, key, object[key])

    if (/** @type {unknown} */ (object) === serialization.values) {
      serialization.changed.push(/** @type {number} */ (key))
    }
  }

  object[key] = value
  return true
}
