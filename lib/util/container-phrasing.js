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
 * @typedef Serialization
 *   State of serializing phrasing with attention.
 *
 *   Phrasing is a tree of nodes (strings and attention),
 *   rendered to tokens (strings, and the opening and closing sequence of
 *   attention).
 *   How a node is rendered depends only on the nodes next to it,
 *   its first and last child, and its parent,
 *   so changing the sequence of attention only renders those again.
 * @property {string} after
 *   Characters after.
 * @property {Array<AttentionResult | undefined>} attentions
 *   Attention of each token, if it is a sequence.
 * @property {string} before
 *   Characters before.
 * @property {Array<number>} changed
 *   Tokens changed by a try.
 * @property {Array<boolean>} closeInsides
 *   Whether attention encodes the character before its closing sequence.
 * @property {Array<boolean>} closeOutsides
 *   Whether attention encodes the character after it.
 * @property {Array<number>} closes
 *   Token of the closing sequence of attention.
 * @property {Array<string | undefined>} encodeAfters
 *   Character to encode if a string starts with it, before each node.
 * @property {Array<number>} firsts
 *   First child of attention, or `-1`.
 * @property {Array<string>} heads
 *   Value of each string before its parent encodes it.
 * @property {boolean} hollow
 *   Whether there is attention without content, which never forms.
 * @property {Array<Array<number> | undefined>} involved
 *   Sequences involved with each sequence that does not form its attention.
 * @property {Array<Item>} items
 *   Item of each node.
 * @property {Array<number>} knowns
 *   Index up to which pairing is known, for each marker.
 * @property {Array<number>} lasts
 *   Last child of attention, or `-1`.
 * @property {Array<unknown> | undefined} log
 *   Changes made by a try, to undo them: array, index, and old value.
 * @property {Array<number>} nexts
 *   Next node, or `-1`.
 * @property {Array<string>} markers
 *   Markers that sequences can use.
 *   Runs of different markers do not affect each other,
 *   so each pairs on its own.
 * @property {Map<AttentionResult, number>} nodes
 *   Node of each attention.
 * @property {Array<boolean>} openInsides
 *   Whether attention encodes the character after its opening sequence.
 * @property {Array<boolean>} openOutsides
 *   Whether attention encodes the character before it.
 * @property {Array<number>} opens
 *   Token of a string, or of the opening sequence of attention.
 * @property {Array<string>} outsideAfters
 *   Character after attention.
 * @property {Array<number>} parents
 *   Parent attention, or `-1`.
 * @property {Array<number>} previousNodes
 *   Previous node, or `-1`.
 * @property {Array<number>} queue
 *   Nodes to render again.
 * @property {Array<boolean>} queued
 *   Whether each node is in `queue`.
 * @property {Array<string>} sequences
 *   Sequence of attention.
 * @property {Array<Array<Snapshot | undefined>>} snapshots
 *   State of pairing before each token that is not in the middle of a run,
 *   for each marker.
 * @property {Array<string>} starts
 *   Value of each string after encoding its start for attention before it.
 * @property {Array<string>} values
 *   Value of each token.
 * @property {Uint8Array} wrongs
 *   Whether each token is a sequence that does not form its attention.
 */

/**
 * @typedef Snapshot
 *   State of pairing at a token.
 * @property {Array<number>} ends
 *   `end` of each run.
 * @property {Array<Array<number> | undefined>} lists
 *   Sequences involved with each sequence of the runs, if wrong.
 * @property {Array<Run>} runs
 *   Runs that can open, in order.
 * @property {Array<number>} sizes
 *   Size of each list at the token.
 * @property {Array<number>} starts
 *   `start` of each run.
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
  const {attentions, nodes, opens, closes, values} = serialization
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
    const node = /** @type {number} */ (nodes.get(attention))

    for (const at of [opens[node], closes[node]]) {
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
      opens[/** @type {number} */ (nodes.get(b))] -
      opens[/** @type {number} */ (nodes.get(a))]
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
  const {involved, knowns, markers, snapshots, values, wrongs} = serialization
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
    wrongs[at] = list ? 1 : 0
    involved[at] = list
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
  const {involved, nodes, sequences} = serialization

  for (const attention of candidates(
    serialization,
    /** @type {Array<number>} */ (involved[mistake])
  )) {
    const current = sequences[/** @type {number} */ (nodes.get(attention))]

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
  const node = /** @type {number} */ (serialization.nodes.get(attention))
  serialization.log = []
  serialization.changed = []
  write(serialization, serialization.sequences, node, sequence)

  for (const other of [
    node,
    serialization.previousNodes[node],
    serialization.nexts[node],
    serialization.firsts[node],
    serialization.lasts[node],
    serialization.parents[node]
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
    write(serialization, serialization.wrongs, at, list ? 1 : 0)
    write(serialization, serialization.involved, at, list)
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
            old &&
            equal(pairing, old)
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
      const array = /** @type {Array<unknown>} */ (log[index])
      array[/** @type {number} */ (log[index + 1])] = log[index + 2]
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
      const involved = [...new Set([...opening, ...closing])]
      // Add to what is involved already: a sequence can be in several pairs.
      for (const at of involved) {
        const list = wrong.get(at)
        if (list) for (const other of involved) list.push(other)
      }
    }

    opener.end -= size
    closer.start += size

    // A sequence is done once all its markers are used.
    for (const at of opening) {
      if (!(
        opener.start < opener.end && opener.markers[opener.end - 1] >= at
      )) {
        decide(at, wrong.get(at))
      }
    }

    for (const at of closing) {
      if (!(closer.start < closer.end && closer.markers[closer.start] <= at)) {
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
    closeInsides: [],
    closeOutsides: [],
    closes: [],
    encodeAfters: [],
    firsts: [],
    heads: [],
    hollow: false,
    involved: [],
    items: [],
    knowns: [],
    lasts: [],
    log: undefined,
    nexts: [],
    markers: [],
    nodes: new Map(),
    openInsides: [],
    openOutsides: [],
    opens: [],
    outsideAfters: [],
    parents: [],
    previousNodes: [],
    queue: [],
    queued: [],
    sequences: [],
    snapshots: [],
    starts: [],
    values: [],
    wrongs: new Uint8Array(0)
  }

  place(serialization, items, -1)
  serialization.wrongs = new Uint8Array(serialization.values.length)

  for (const _ of serialization.markers) {
    serialization.knowns.push(0)
    serialization.snapshots.push([snapshot({pending: [], wrong: new Map()})])
  }

  let index = -1
  while (++index < serialization.items.length) enqueue(serialization, index)
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
 * @param {number} parent
 *   Parent attention, or `-1`.
 * @returns {undefined}
 *   Nothing.
 */
function place(serialization, items, parent) {
  const {attentions, values} = serialization
  let previous = -1

  for (const item of items) {
    const node = serialization.items.length
    const sequence = typeof item === 'string' ? '' : item.sequences[0]
    serialization.items.push(item)
    serialization.parents.push(parent)
    serialization.previousNodes.push(previous)
    serialization.nexts.push(-1)
    serialization.firsts.push(-1)
    serialization.lasts.push(-1)
    serialization.sequences.push(sequence)
    serialization.encodeAfters.push(undefined)
    serialization.starts.push('')
    serialization.heads.push('')
    serialization.outsideAfters.push('')
    serialization.openInsides.push(false)
    serialization.openOutsides.push(false)
    serialization.closeInsides.push(false)
    serialization.closeOutsides.push(false)
    serialization.queued.push(false)
    serialization.opens.push(values.length)
    serialization.closes.push(values.length)
    if (previous === -1 && parent !== -1) serialization.firsts[parent] = node
    if (previous !== -1) serialization.nexts[previous] = node
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
      serialization.closes[node] = values.length
      values.push(sequence)
      attentions.push(item)
    }
  }

  if (parent !== -1) serialization.lasts[parent] = previous
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
 * @param {number} node
 *   Node, or `-1`.
 * @returns {undefined}
 *   Nothing.
 */
function enqueue(serialization, node) {
  if (node !== -1 && serialization.queued[node] === false) {
    serialization.queued[node] = true
    serialization.queue.push(node)
  }
}

/**
 * Check whether the state of pairing is the same as a snapshot.
 *
 * @param {Pairing} pairing
 *   State of pairing.
 * @param {Snapshot} state
 *   Snapshot.
 * @returns {boolean}
 *   Whether they are the same.
 */
function equal(pairing, state) {
  if (pairing.pending.length !== state.runs.length) return false
  let index = -1
  let list = 0

  while (++index < state.runs.length) {
    const run = pairing.pending[index]
    const old = state.runs[index]

    if (
      run.start !== state.starts[index] ||
      run.end !== state.ends[index] ||
      run.open !== old.open ||
      run.close !== old.close ||
      run.split !== old.split ||
      run.markers.length !== old.markers.length ||
      run.markers.some((at, position) => at !== old.markers[position])
    ) {
      return false
    }

    for (const at of run.tokens) {
      const now = pairing.wrong.get(at)
      const then = state.lists[list]
      const size = state.sizes[list++]

      if (
        (now ? now.length : 0) !== size ||
        now?.some((other, position) => other !== then?.[position])
      ) {
        return false
      }
    }
  }

  return true
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
  let index = -1
  let list = 0

  while (++index < state.runs.length) {
    pairing.pending.push({
      ...state.runs[index],
      start: state.starts[index],
      end: state.ends[index]
    })

    for (const at of state.runs[index].tokens) {
      const then = state.lists[list]
      if (then) pairing.wrong.set(at, then.slice(0, state.sizes[list]))
      list++
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
    serialization.queued[queue[index]] = false
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
  /** @type {Snapshot} */
  const state = {ends: [], lists: [], runs: [], sizes: [], starts: []}

  for (const run of pairing.pending) {
    state.runs.push(run)
    state.starts.push(run.start)
    state.ends.push(run.end)

    for (const at of run.tokens) {
      const list = pairing.wrong.get(at)
      state.lists.push(list)
      state.sizes.push(list ? list.length : 0)
    }
  }

  return state
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
 * @param {number} node
 *   Node.
 * @returns {undefined}
 *   Nothing.
 */
function update(serialization, node) {
  const {firsts, heads, lasts, nexts, parents, sequences} = serialization
  const before = serialization.previousNodes[node]
  const next = nexts[node]
  const parent = parents[node]
  const item = serialization.items[node]
  /** @type {string} */
  let previous
  /** @type {string | undefined} */
  let encodeAfter

  if (before === -1) {
    previous = lastCharacter(
      parent === -1 ? serialization.before : sequences[parent]
    )
  } else if (typeof serialization.items[before] === 'string') {
    previous = lastCharacter(serialization.starts[before])
  } else {
    previous = sequences[before].charAt(sequences[before].length - 1)
    encodeAfter =
      serialization.closeOutsides[before] === true
        ? serialization.outsideAfters[before]
        : serialization.encodeAfters[before]
  }

  if (write(serialization, serialization.encodeAfters, node, encodeAfter)) {
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

    if (
      next !== -1 &&
      serialization.openOutsides[next] === true &&
      typeof serialization.items[next] !== 'string'
    ) {
      const outside = lastCharacter(start)
      if (outside !== '\n' && outside !== '\r') encode(token, false)
    }

    const head = token.value

    if (
      parent !== -1 &&
      firsts[parent] === node &&
      serialization.openInsides[parent] === true
    ) {
      encode(token, true)
    }

    if (
      parent !== -1 &&
      lasts[parent] === node &&
      serialization.closeInsides[parent] === true
    ) {
      encode(token, false)
    }

    if (write(serialization, serialization.starts, node, start)) {
      enqueue(serialization, next)
    }

    if (
      write(serialization, heads, node, head) &&
      parent !== -1 &&
      (firsts[parent] === node || lasts[parent] === node)
    ) {
      enqueue(serialization, parent)
    }

    write(
      serialization,
      serialization.values,
      serialization.opens[node],
      token.value
    )
    return
  }

  const sequence = sequences[node]
  const marker = sequence.charAt(0)
  const first = firsts[node]
  const last = lasts[node]
  const nextItem = next === -1 ? undefined : serialization.items[next]
  const outsideAfter = firstCharacter(
    nextItem === undefined
      ? parent === -1
        ? serialization.after
        : sequences[parent]
      : typeof nextItem === 'string'
        ? nextItem
        : sequences[next]
  )
  const head =
    first === -1
      ? ''
      : typeof serialization.items[first] === 'string'
        ? heads[first]
        : sequences[first]
  const open = encodeInfo(
    previous.charCodeAt(previous.length - 1),
    head.charCodeAt(0),
    marker
  )
  /** @type {Token} */
  const inside = {
    attention: undefined,
    value:
      last === -1
        ? ''
        : typeof serialization.items[last] === 'string'
          ? heads[last]
          : sequences[last]
  }

  if (
    open.inside &&
    last === first &&
    last !== -1 &&
    typeof serialization.items[last] === 'string' &&
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

  if (write(serialization, serialization.openInsides, node, open.inside)) {
    enqueue(serialization, first)
  }

  if (write(serialization, serialization.openOutsides, node, open.outside)) {
    enqueue(serialization, before)
  }

  if (write(serialization, serialization.closeInsides, node, close.inside)) {
    enqueue(serialization, last)
  }

  const movedClose = write(
    serialization,
    serialization.closeOutsides,
    node,
    close.outside
  )
  const movedAfter = write(
    serialization,
    serialization.outsideAfters,
    node,
    outsideAfter
  )

  if (movedClose || movedAfter) {
    enqueue(serialization, next)
  }

  write(
    serialization,
    serialization.values,
    serialization.opens[node],
    sequence
  )
  write(
    serialization,
    serialization.values,
    serialization.closes[node],
    sequence
  )
}

/**
 * Set a value, logging the change while trying.
 *
 * @template T
 *   Value.
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Record<number, T>} array
 *   Array, changed.
 * @param {number} index
 *   Index.
 * @param {T} value
 *   Value.
 * @returns {boolean}
 *   Whether it changed.
 */
function write(serialization, array, index, value) {
  if (array[index] === value) return false

  if (serialization.log) {
    serialization.log.push(array, index, array[index])
    if (/** @type {unknown} */ (array) === serialization.values) {
      serialization.changed.push(index)
    }
  }

  array[index] = value
  return true
}
