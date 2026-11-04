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
 * @typedef {AttentionResult | string} Item
 *   Serialized phrasing.
 */

/**
 * @typedef Node
 *   Item, as rendered.
 *   How a node renders depends only on the nodes next to it,
 *   its first and last child, and its parent,
 *   so a change only renders those again,
 *   and spreads further only through what changes.
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
 * @property {Node | undefined} parent
 *   Parent attention.
 * @property {Node | undefined} previous
 *   Previous node.
 * @property {boolean} queued
 *   Whether the node is queued to render again.
 * @property {string} sequence
 *   Sequence of attention, or value of a string.
 * @property {string} start
 *   Value of a string after encoding its start for attention before it.
 */

/**
 * @typedef Pairing
 *   State of pairing runs of a marker like `micromark`.
 * @property {number} count
 *   Runs paired since the last snapshot.
 * @property {number} index
 *   Token where pairing is.
 * @property {Array<Run>} pending
 *   Runs that can open, in order.
 * @property {Snapshot | undefined} state
 *   Snapshot at `index`, if kept.
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
 * @property {number} start
 *   Index of the first marker not used (to close).
 * @property {Array<number>} tokens
 *   Token indices of the sequences.
 */

/**
 * @typedef Serialization
 *   State of serializing phrasing with attention:
 *   nodes (strings and attention) rendered to tokens (strings, and the
 *   opening and closing sequence of attention).
 * @property {string} after
 *   Characters after.
 * @property {Array<Node | undefined>} attentions
 *   Attention of each token, if it is a sequence.
 * @property {string} before
 *   Characters before.
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
 * @property {number} mistake
 *   Mistake while trying, or `-1`.
 * @property {Array<Node>} queue
 *   Nodes to render again.
 * @property {Array<Array<Snapshot | undefined>>} snapshots
 *   State of pairing before some tokens that are not in the middle of a
 *   run, for each marker.
 * @property {Array<string>} values
 *   Value of each token.
 * @property {boolean} worse
 *   Whether a try made a sequence up to the mistake not form.
 */

/**
 * @typedef {string} Snapshot
 *   State of pairing at a token, as JSON:
 *   for each run that can open, its `start`, `end`, `close`,
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
 * @returns {Array<Node>}
 *   Candidates.
 */
function candidates(serialization, involved) {
  const {attentions, values} = serialization
  /** @type {Set<Node>} */
  const related = new Set()
  /** @type {Set<number>} */
  const seen = new Set()

  // The attention involved, and attention in runs with its sequences.
  for (const sequence of involved) {
    const node = /** @type {Node} */ (attentions[sequence])
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
        related.add(/** @type {Node} */ (attentions[start++]))
      }
    }
  }

  // Later first: attention that opens later is inner or next.
  return [...related].sort((a, b) => b.open - a.open)
}

/**
 * Check whether sequences form their attention, like `micromark`.
 *
 * Sequences of `*` and `_` pair like emphasis and strong in CommonMark,
 * others like strikethrough in GFM.
 * This continues from where pairing is known,
 * until the first sequence that does not is known,
 * and keeps the state of pairing before some runs,
 * so that a try can pair again from the nearest one.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} from
 *   Index to find the first mistake from.
 * @returns {number}
 *   First sequence that does not form its attention, or `-1`.
 */
function check(serialization, from) {
  const {involved, knowns, markers, snapshots, values} = serialization
  const length = values.length
  const pairings = knowns.map((index, lane) =>
    restore(/** @type {Snapshot} */ (snapshots[lane][index]), index)
  )
  let first = from

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

    while (first < frontier && involved[first] === undefined) first++
    if (first < frontier || behind === -1) break

    // Pair further for the marker that is behind.
    const pairing = pairings[behind]
    advance(serialization, behind, pairing)
    snapshots[behind][pairing.index] = pairing.state
    knowns[behind] = pairing.index
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
  for (const node of candidates(
    serialization,
    /** @type {Array<number>} */ (serialization.involved[mistake])
  )) {
    for (const sequence of /** @type {AttentionResult} */ (node.item)
      .sequences) {
      if (
        sequence !== node.sequence &&
        attempt(serialization, node, sequence, mistake)
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
 * and for each marker, runs are paired again around each changed token,
 * from the nearest snapshot,
 * until the state of pairing is as it was before,
 * or until sequences up to the mistake are done pairing,
 * where pairing is then known.
 *
 * @param {Serialization} serialization
 *   State, changed if better.
 * @param {Node} node
 *   Attention.
 * @param {string} sequence
 *   Sequence to try.
 * @param {number} mistake
 *   Index of the mistake.
 * @returns {boolean}
 *   Whether that is better.
 */
function attempt(serialization, node, sequence, mistake) {
  const {knowns, markers, snapshots, values} = serialization
  const length = values.length
  serialization.log = []
  write(serialization, node, 'sequence', sequence)
  write(serialization, node, 'head', sequence)
  write(serialization, node, 'start', sequence)

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

  const log = /** @type {Array<unknown>} */ (serialization.log)
  /** @type {Set<number>} */
  const tokens = new Set()

  for (let index = 0; index < log.length; index += 3) {
    if (log[index] === values)
      tokens.add(/** @type {number} */ (log[index + 1]))
  }

  const changed = [...tokens].sort((a, b) => a - b)
  serialization.mistake = mistake
  serialization.worse = false

  let lane = -1

  while (++lane < markers.length && !serialization.worse) {
    const known = knowns[lane]
    const states = snapshots[lane]
    let next = 0

    while (
      next < changed.length &&
      changed[next] <= known &&
      !serialization.worse
    ) {
      // Start at a snapshot before the token before the change,
      // as the run with that token can open or close depending on it.
      let index = Math.max(changed[next] - 1, 0)
      while (index > 0 && states[index] === undefined) index--
      const pairing = restore(/** @type {Snapshot} */ (states[index]), index)

      while (!serialization.worse) {
        advance(serialization, lane, pairing)
        index = pairing.index
        while (next < changed.length && changed[next] < index - 1) next++
        const old = states[index]
        // Compare where a snapshot was kept.
        if (old !== undefined) pairing.state ||= snapshot(pairing)

        // Where pairing is as before, and the tokens around are as before,
        // the rest pairs as before until the next change.
        // Sequences up to the mistake that are still open then are done
        // pairing before `known`, as `check` found the mistake.
        if (
          index <= known &&
          (next === changed.length || changed[next] > index) &&
          old !== undefined &&
          old === pairing.state
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
            pairing.state || snapshot(pairing)
          )
          write(serialization, knowns, lane, index)
          next = changed.length
          break
        }

        write(serialization, states, index, pairing.state)
      }
    }
  }

  serialization.log = undefined
  serialization.mistake = -1

  // Better if the mistake now forms, and nothing before it does not.
  if (serialization.worse || serialization.involved[mistake] !== undefined) {
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
 * mark sequences that do form their attention as fine,
 * and decide sequences once all their markers are used.
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
 * @returns {undefined}
 *   Nothing.
 */
function pair(serialization, pairing, closer) {
  const {attentions, values} = serialization
  const {pending, wrong} = pairing
  // Builtins can split runs.
  const split = builtins.has(values[closer.tokens[0]].charAt(0))
  let open = closer.close ? pending.length : 0

  while (open-- && closer.start < closer.end) {
    const opener = pending[open]
    const openerSize = opener.end - opener.start
    const closerSize = closer.end - closer.start

    if (
      split
        ? // The rule of 3, on the sizes that are left.
          (opener.close || closer.open) &&
          closerSize % 3 &&
          !((openerSize + closerSize) % 3)
        : // Others pair whole runs of the same size.
          openerSize !== opener.markers.length || openerSize !== closerSize
    ) {
      continue
    }

    const size = split ? (openerSize > 1 && closerSize > 1 ? 2 : 1) : closerSize
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
        decide(serialization, at, wrong.get(at))
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
    hollow: false,
    involved: [],
    knowns: [],
    log: undefined,
    markers: [],
    mistake: -1,
    queue: [],
    snapshots: [],
    values: [],
    worse: false
  }

  place(serialization, items, undefined)
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
    const sequence = typeof item === 'string' ? item : item.sequences[0]
    /** @type {Node} */
    const node = {
      close: values.length,
      closeInside: false,
      closeOutside: false,
      encodeAfter: undefined,
      first: undefined,
      head: sequence,
      item,
      last: undefined,
      next: undefined,
      open: values.length,
      openInside: false,
      openOutside: false,
      parent,
      previous,
      queued: false,
      sequence,
      start: sequence
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
        if (serialization.markers.includes(marker)) {
          continue
        }

        serialization.markers.push(marker)
        serialization.knowns.push(0)
        // Nothing pending.
        serialization.snapshots.push(['[]'])
      }

      values.push(sequence)
      attentions.push(node)
      place(serialization, item.children, node)
      node.close = values.length
      values.push(sequence)
      attentions.push(node)
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
    return items.join('')
  }

  const serialization = render(items, before, after)
  const initial = serialization.values.join('')

  // Attention without content never forms.
  if (serialization.hollow) return initial

  let mistake = check(serialization, 0)
  if (mistake === -1) return initial

  while (mistake !== -1) {
    if (!improve(serialization, mistake)) return initial
    // Mistakes only move further.
    mistake = check(serialization, mistake + 1)
  }

  return serialization.values.join('')
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
 * @returns {undefined}
 *   Nothing.
 */
function advance(serialization, lane, pairing) {
  const states = serialization.snapshots[lane]

  if (isMarker(serialization, pairing.index, serialization.markers[lane])) {
    const end = step(serialization, pairing, pairing.index)

    while (++pairing.index < end) {
      write(serialization, states, pairing.index, undefined)
    }

    // A snapshot takes as long as the runs that can open,
    // so keep one once as many runs paired.
    pairing.state = undefined

    if (++pairing.count >= pairing.pending.length) {
      pairing.count = 0
      pairing.state = snapshot(pairing)
    }
  } else {
    pairing.index++
  }

  // At the end, what is still open does not form.
  if (pairing.index === serialization.values.length) {
    for (const run of pairing.pending) {
      for (const at of run.tokens) {
        decide(serialization, at, pairing.wrong.get(at))
      }
    }

    pairing.pending = []
    pairing.state = snapshot(pairing)
  }
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
function decide(serialization, at, list) {
  write(serialization, serialization.involved, at, list)
  if (list && at <= serialization.mistake) serialization.worse = true
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
 * Get the state of pairing of a snapshot.
 *
 * @param {Snapshot} state
 *   Snapshot.
 * @param {number} index
 *   Token of the snapshot.
 * @returns {Pairing}
 *   State of pairing.
 */
function restore(state, index) {
  /** @type {Pairing} */
  const pairing = {count: 0, index, pending: [], state, wrong: new Map()}
  /** @type {Array<[number, number, boolean, Array<number>, Array<Array<number> | null>]>} */
  const runs = JSON.parse(state)

  // Runs that can still open.
  for (const [start, end, close, markers, lists] of runs) {
    const tokens = [...new Set(markers)]
    pairing.pending.push({
      close,
      end,
      markers,
      // Pending runs can open, `pair` checks this on closers only.
      open: true,
      start,
      tokens
    })

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
  return JSON.stringify(
    pairing.pending.map((run) => [
      run.start,
      run.end,
      run.close,
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
 * @returns {number}
 *   Index after the run.
 */
function step(serialization, pairing, index) {
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
    close: strict ? close && (Boolean(next) || !open) : close
  }

  for (let at = index; at < end; at++) run.tokens.push(at)

  for (const at of run.tokens) {
    // Every sequence is wrong until it pairs with its other sequence.
    pairing.wrong.set(at, [...run.tokens])
    let size = values[at].length
    while (size--) run.markers.push(at)
  }

  run.end = run.markers.length
  pair(serialization, pairing, run)

  if (run.open && run.start < run.end) {
    pairing.pending.push(run)
  } else {
    for (const at of run.tokens) {
      decide(serialization, at, pairing.wrong.get(at))
    }
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
    encodeAfter = before.closeOutside
      ? firstCharacter(node.sequence)
      : before.encodeAfter
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

    if (parent && parent.first === node && parent.openInside) {
      encode(token, true)
    }

    if (parent && parent.last === node && parent.closeInside) {
      encode(token, false)
    }

    if (write(serialization, node, 'start', start)) enqueue(serialization, next)

    if (write(serialization, node, 'head', head)) enqueue(serialization, parent)

    write(serialization, serialization.values, node.open, token.value)
    return
  }

  const {sequence} = node
  const marker = sequence.charAt(0)
  const previous = lastCharacter(
    before ? before.start : parent ? parent.sequence : serialization.before
  )
  const outsideAfter = firstCharacter(
    next ? next.sequence : parent ? parent.sequence : serialization.after
  )
  const head = first ? first.head : ''
  const open = encodeInfo(
    previous.charCodeAt(previous.length - 1),
    head.charCodeAt(0),
    marker
  )
  /** @type {Token} */
  const inside = {
    attention: undefined,
    value: last ? last.head : ''
  }

  if (open.inside && last === first && last && typeof last.item === 'string') {
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

  if (write(serialization, node, 'closeOutside', close.outside)) {
    enqueue(serialization, next)
  }

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

  if (serialization.log) serialization.log.push(object, key, object[key])

  object[key] = value
  return true
}
