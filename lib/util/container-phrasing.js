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
 * @typedef Patch
 *   Change to snapshots after a try that changed only runs no later run looks
 *   at until some token (see `covers`):
 *   those runs, before `cut`, are replaced by `add`.
 * @property {string} add
 *   Runs, as in a snapshot.
 * @property {number} cut
 *   First sequence of the runs that stay.
 * @property {number} epoch
 *   Snapshots kept before it are changed.
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
 * @property {number} epoch
 *   Count of patches, never undone.
 * @property {Array<Array<Array<number> | undefined>>} covers
 *   For each marker,
 *   a tree of the patches that change the snapshots of all tokens under each
 *   node, by index, if any.
 * @property {Array<Array<number>>} epochs
 *   Epoch of each snapshot, for each marker.
 * @property {boolean} hollow
 *   Whether there is attention without content, which never forms.
 * @property {Array<Array<number> | undefined>} involved
 *   Sequences involved with each sequence that does not form its attention.
 * @property {Array<number>} knowns
 *   Index up to which pairing is known, for each marker.
 * @property {Array<unknown> | undefined} log
 *   Changes made by a try, to undo them: object, key, and old value.
 * @property {Array<[Array<number>, Array<number>]>} kinds
 *   For each marker,
 *   trees of the smallest and largest kind of the runs that look at all runs
 *   that can open,
 *   by first sequence,
 *   where the kind is how many markers are left modulo 3,
 *   times 2, plus whether it can open:
 *   each node has the smallest or largest of its two children,
 *   `Infinity` or `-Infinity` for none, leaves are last.
 * @property {Array<Array<number>>} lows
 *   For each marker,
 *   a tree like `kinds`, of the first sequence of the lowest run that each run
 *   pairs with to close.
 * @property {Array<string>} markers
 *   Markers that sequences can use.
 *   Runs of different markers do not affect each other,
 *   so each pairs on its own.
 * @property {number} mistake
 *   Mistake while trying, or `-1`.
 * @property {Array<Array<Patch>>} patches
 *   Patches of snapshots, for each marker.
 * @property {Array<Node>} queue
 *   Nodes to render again.
 * @property {number} size
 *   Leaves of trees: a power of two above the count of tokens.
 * @property {Array<Array<Snapshot | undefined>>} snapshots
 *   State of pairing before some tokens that are not in the middle of a
 *   run, for each marker.
 * @property {boolean} trying
 *   Whether there is a mistake,
 *   so that pairing keeps what tries need:
 *   snapshots and trees.
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
 *   and the sequences involved with each of its sequences, if wrong
 *   (`0` if those are the sequences of the run).
 */

/**
 * @typedef Token
 *   Rendered phrasing.
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
    restore(serialization, lane, index)
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
    keep(serialization, behind, pairing.index, pairing.state)
    knowns[behind] = pairing.index
  }

  // Keep the state where pairing is known.
  for (const [lane, pairing] of pairings.entries()) {
    if (serialization.trying && snapshots[lane][knowns[lane]] === undefined) {
      keep(serialization, lane, knowns[lane], snapshot(pairing))
    }
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
 * except for runs left open and not paired further until the end,
 * or until sequences up to the mistake are done pairing,
 * where pairing is then known,
 * or once the mistake can no longer form.
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
  // Once pairing is past the closing sequence of the mistake,
  // it formed or never will.
  const settled = /** @type {Node} */ (serialization.attentions[mistake]).close
  let lane = -1

  while (++lane < markers.length && !serialization.worse) {
    const known = knowns[lane]
    const split = builtins.has(markers[lane])
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
      let pairing = restore(serialization, lane, index)

      while (!serialization.worse) {
        advance(serialization, lane, pairing)
        index = pairing.index

        if (index > settled && pairing.wrong.get(mistake) !== undefined) {
          serialization.worse = true
          break
        }

        while (next < changed.length && changed[next] < index - 1) next++
        if (states[index] !== undefined) pairing.state ||= snapshot(pairing)

        // Where pairing is as before, and the tokens around are as before,
        // the rest pairs as before until the next change.
        // Sequences up to the mistake that are still open then are done
        // pairing before `known`, as `check` found the mistake.
        const compared =
          index <= known &&
          (next === changed.length || changed[next] > index) &&
          states[index] !== undefined

        if (compared) {
          const olds = entries(serialization, lane, index).map((run) =>
            JSON.stringify(run)
          )
          const news = pairing.pending.map((run) => entry(pairing, run))
          let common = 0

          while (
            common < olds.length &&
            common < news.length &&
            olds[olds.length - 1 - common] === news[news.length - 1 - common]
          ) {
            common++
          }

          if (common === olds.length && common === news.length) break

          // Runs that differ pair with nothing until a later run pairs with
          // one of them before,
          // or looks at all of them while it does not skip each of them,
          // following the rule of 3 in `pair`:
          // until then, pair as before, with those runs as they are now.
          const cut =
            common > 0 ? pairing.pending[news.length - common].tokens[0] : index
          const bottom = pairing.pending.slice(0, news.length - common)
          let low = -Infinity
          let high = Infinity

          for (const run of bottom) {
            const size = (run.end - run.start) % 3

            // Skipped by runs with `3 - size` left that can open,
            // or that cannot if it can close.
            if (split && size) {
              const kind = (3 - size) * 2
              low = Math.max(low, run.close ? kind : kind + 1)
              high = Math.min(high, kind + 1)
            } else {
              low = Infinity
            }
          }

          const far = Math.min(
            reach(serialization, lane, index, cut, low, high),
            next === changed.length ? Infinity : changed[next] - 1
          )
          // Nothing pairs with them until the end, where they do not form.
          const ended = far === Infinity && known === length
          let to = ended ? length - 1 : Math.min(far, known, length - 1)
          if (!ended) {
            while (to > index && states[to] === undefined) to--
          }

          if (to > index) {
            keep(serialization, lane, index, pairing.state)
            add(serialization, serialization.patches, lane, {
              add: '[' + news.slice(0, news.length - common).join(',') + ']',
              cut,
              epoch: ++serialization.epoch
            })
            cover(serialization, lane, index + 1, to)

            if (ended) {
              for (const run of bottom) {
                for (const at of run.tokens) {
                  decide(serialization, at, pairing.wrong.get(at))
                }
              }

              break
            }

            pairing = restore(serialization, lane, to)
            continue
          }
        }

        // Stop once sequences up to the mistake are done pairing.
        // Where pairing is known,
        // first compare at a snapshot after the changes,
        // as the rest may pair as before.
        const done = index > mistake && undone(pairing) > mistake

        if (
          index === length ||
          (done && (index > known || (compared && next === changed.length)))
        ) {
          keep(serialization, lane, index, pairing.state || snapshot(pairing))
          write(serialization, knowns, lane, index)
          next = changed.length
          break
        }

        keep(serialization, lane, index, pairing.state)
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
 * @param {number} lane
 *   Marker.
 * @param {Pairing} pairing
 *   State of pairing, changed.
 * @param {Run} closer
 *   Run.
 * @returns {undefined}
 *   Nothing.
 */
function pair(serialization, lane, pairing, closer) {
  const {attentions, values} = serialization
  const {pending, wrong} = pairing
  // Builtins can split runs.
  const split = builtins.has(values[closer.tokens[0]].charAt(0))
  let open = closer.close ? pending.length : 0
  let low = Infinity

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

    low = Math.min(low, opener.tokens[0])
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
      // Lists are shared, so this makes a new one.
      // Sequences that formed have no markers left, so these are all wrong.
      for (const at of involved) {
        const list = /** @type {Array<number>} */ (wrong.get(at))
        const added = involved.filter((other) => !list.includes(other))
        if (added.length > 0) wrong.set(at, [...list, ...added])
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

  const kind = ((closer.end - closer.start) % 3) * 2
  look(
    serialization,
    lane,
    closer.tokens[0],
    low,
    // Left after looking at all runs.
    closer.close && closer.start < closer.end
      ? split
        ? kind + Number(closer.open)
        : 0
      : undefined
  )
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
    covers: [],
    epoch: 0,
    epochs: [],
    hollow: false,
    involved: [],
    knowns: [],
    log: undefined,
    kinds: [],
    lows: [],
    markers: [],
    mistake: -1,
    patches: [],
    queue: [],
    size: 1,
    snapshots: [],
    trying: false,
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
        serialization.covers.push([])
        serialization.epochs.push([0])
        serialization.patches.push([])
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
  plant(serialization)
  mistake = check(serialization, 0)

  while (mistake !== -1) {
    if (!improve(serialization, mistake)) return initial
    // Mistakes only move further.
    mistake = check(serialization, mistake + 1)
  }

  return serialization.values.join('')
}

/**
 * Add a value to a list.
 *
 * @template T
 *   Value.
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Array<Array<T> | undefined>} lists
 *   Lists.
 * @param {number} index
 *   List.
 * @param {T} value
 *   Value.
 * @returns {undefined}
 *   Nothing.
 */
function add(serialization, lists, index, value) {
  if (lists[index] === undefined) write(serialization, lists, index, [])
  const list = /** @type {Array<T>} */ (lists[index])
  // Grow first, so that undoing shrinks it again.
  write(serialization, list, 'length', list.length + 1)
  write(serialization, list, list.length - 1, value)
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
  const marker = serialization.markers[lane]
  const length = serialization.values.length
  const states = serialization.snapshots[lane]

  if (isMarker(serialization, pairing.index, marker)) {
    const end = step(serialization, lane, pairing, pairing.index)

    while (++pairing.index < end) {
      write(serialization, states, pairing.index, undefined)
      look(serialization, lane, pairing.index, Infinity, undefined)
    }

    // A snapshot takes as long as the runs that can open,
    // so keep one once as many runs paired.
    pairing.state = undefined

    if (serialization.trying && ++pairing.count >= pairing.pending.length) {
      pairing.count = 0
      pairing.state = snapshot(pairing)
    }
  } else {
    // Move past tokens of other markers or strings at once,
    // up to a snapshot, which callers compare.
    while (true) {
      look(serialization, lane, pairing.index++, Infinity, undefined)
      if (
        pairing.index === length ||
        states[pairing.index] !== undefined ||
        isMarker(serialization, pairing.index, marker)
      )
        break
      keep(serialization, lane, pairing.index, pairing.state)
    }
  }

  // At the end, what is still open does not form.
  if (pairing.index === length) {
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
 * Note that the last patch changes snapshots from a token to another.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} lane
 *   Marker.
 * @param {number} from
 *   First token.
 * @param {number} to
 *   Last token.
 * @returns {undefined}
 *   Nothing.
 */
function cover(serialization, lane, from, to) {
  const patches = serialization.patches[lane]
  const tree = serialization.covers[lane]
  const at = patches.length - 1
  let start = serialization.size + from
  let end = serialization.size + to + 1
  /** @type {Array<number>} */
  const nodes = []

  while (start < end) {
    if (start % 2) nodes.push(start++)
    if (end % 2) nodes.push(--end)
    start = Math.floor(start / 2)
    end = Math.floor(end / 2)
  }

  for (const node of nodes) {
    const list = tree[node] || []

    // Earlier patches with a lower `cut` change nothing where this one does.
    while (
      list.length > 0 &&
      patches[list[list.length - 1]].cut <= patches[at].cut
    ) {
      // Change the value first, so that undoing restores it.
      write(serialization, list, list.length - 1, -1)
      write(serialization, list, 'length', list.length - 1)
    }

    add(serialization, tree, node, at)
  }
}

/**
 * Set the lowest run that a run pairs with to close,
 * and its kind if it looks at all runs that can open.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} lane
 *   Marker.
 * @param {number} at
 *   First sequence of the run.
 * @param {number} low
 *   First sequence of the lowest run it pairs with.
 * @param {number | undefined} kind
 *   Kind, if it looks at all runs.
 * @returns {undefined}
 *   Nothing.
 */
function look(serialization, lane, at, low, kind) {
  if (!serialization.trying) return
  const [smallest, largest] = serialization.kinds[lane]
  set(serialization, serialization.lows[lane], at, low, Math.min)
  set(serialization, smallest, at, kind ?? Infinity, Math.min)
  set(serialization, largest, at, kind ?? -Infinity, Math.max)
}

/**
 * Find the first run from a token that pairs with a run before another token,
 * or looks at all runs while it is not of some kinds.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} lane
 *   Marker.
 * @param {number} from
 *   Token to search from.
 * @param {number} below
 *   Token.
 * @param {number} low
 *   Smallest kind that is fine.
 * @param {number} high
 *   Largest kind that is fine.
 * @returns {number}
 *   First sequence of that run, or `Infinity`.
 */
function reach(serialization, lane, from, below, low, high) {
  const [smallest, largest] = serialization.kinds[lane]
  const lows = serialization.lows[lane]
  const size = serialization.size
  /**
   * Check a node.
   *
   * @param {number} node
   *   Node.
   * @returns {boolean}
   *   Whether a leaf under it is such a run.
   */
  const hit = (node) =>
    lows[node] < below || smallest[node] < low || largest[node] > high
  let index = size + from

  while (!hit(index)) {
    // To the next node on the right.
    while (index % 2) index = (index - 1) / 2
    if (index === 0) return Infinity
    index++
  }

  while (index < size) {
    index *= 2
    if (!hit(index)) index++
  }

  return index - size
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
 * Get the runs of a snapshot, patched.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} lane
 *   Marker.
 * @param {number} index
 *   Token of the snapshot.
 * @returns {Array<[number, number, boolean, Array<number>, Array<Array<number> | 0 | null>]>}
 *   Runs.
 */
function entries(serialization, lane, index) {
  const patches = serialization.patches[lane]
  const epoch = serialization.epochs[lane][index]
  const tree = serialization.covers[lane]
  /** @type {Array<Array<number>>} */
  const lists = []
  /** @type {Array<number>} */
  const ends = []
  /** @type {Array<[number, number, boolean, Array<number>, Array<Array<number> | 0 | null>]>} */
  const runs = []
  let cut = -Infinity
  let node = serialization.size + index

  // Patches that change this token.
  while (node) {
    const list = tree[node]

    if (list) {
      lists.push(list)
      ends.push(list.length)
    }

    node = Math.floor(node / 2)
  }

  // Later patches first: each keeps runs from its `cut` of what is before it.
  while (true) {
    let last = -1
    let which = -1

    for (const [at, list] of lists.entries()) {
      // Patches with a lower `cut` change nothing more:
      // in a list, later ones have a lower `cut`, so skip them.
      let low = 0
      let high = ends[at]

      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (patches[list[middle]].cut > cut) low = middle + 1
        else high = middle
      }

      ends[at] = low
      if (low === 0 || list[low - 1] < last) continue
      last = list[low - 1]
      which = at
    }

    const patch = patches[last]
    if (!patch || patch.epoch <= epoch) break
    ends[which]--
    /** @type {typeof runs} */
    const added = JSON.parse(patch.add)
    for (const run of added) if (run[3][0] >= cut) runs.push(run)
    cut = Math.max(cut, patch.cut)
  }

  /** @type {typeof runs} */
  const kept = JSON.parse(
    /** @type {Snapshot} */ (serialization.snapshots[lane][index])
  )
  for (const run of kept) if (run[3][0] >= cut) runs.push(run)

  // Keep the patched snapshot, so that later reads skip those patches.
  if (cut > -Infinity) keep(serialization, lane, index, JSON.stringify(runs))

  return runs
}

/**
 * Keep a snapshot.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} lane
 *   Marker.
 * @param {number} index
 *   Token.
 * @param {Snapshot | undefined} state
 *   Snapshot.
 * @returns {undefined}
 *   Nothing.
 */
function keep(serialization, lane, index, state) {
  write(serialization, serialization.snapshots[lane], index, state)

  if (state !== undefined) {
    write(serialization, serialization.epochs[lane], index, serialization.epoch)
  }
}

/**
 * Get the state of pairing of a snapshot.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} lane
 *   Marker.
 * @param {number} index
 *   Token of the snapshot.
 * @returns {Pairing}
 *   State of pairing.
 */
function restore(serialization, lane, index) {
  /** @type {Pairing} */
  const pairing = {
    count: 0,
    index,
    pending: [],
    state: undefined,
    wrong: new Map()
  }

  // Runs that can still open.
  for (const [start, end, close, markers, lists] of entries(
    serialization,
    lane,
    index
  )) {
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
      if (list !== null) {
        pairing.wrong.set(tokens[index], list === 0 ? tokens : list)
      }
    }
  }

  return pairing
}

/**
 * Forget pairing and create the trees that tries use,
 * so that pairing again keeps what tries need.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @returns {undefined}
 *   Nothing.
 */
function plant(serialization) {
  while (serialization.size <= serialization.values.length) {
    serialization.size *= 2
  }

  serialization.involved = []
  serialization.trying = true

  for (const lane of serialization.markers.keys()) {
    serialization.epochs[lane] = [0]
    serialization.knowns[lane] = 0
    serialization.snapshots[lane] = ['[]']
    serialization.kinds.push([
      tree(serialization, Infinity),
      tree(serialization, -Infinity)
    ])
    serialization.lows.push(tree(serialization, Infinity))
  }
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
 * Set a leaf of a tree, and the nodes above it.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Array<number>} tree
 *   Tree.
 * @param {number} at
 *   Leaf.
 * @param {number} value
 *   Value.
 * @param {(left: number, right: number) => number} combine
 *   Get the value of a node from its two children.
 * @returns {undefined}
 *   Nothing.
 */
function set(serialization, tree, at, value, combine) {
  let index = serialization.size + at

  while (write(serialization, tree, index, value) && index > 1) {
    index = Math.floor(index / 2)
    const left = index * 2
    value = combine(tree[left], tree[left + 1])
  }
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
  return pairing.pending.length === 0
    ? '[]'
    : JSON.stringify(pairing.pending.map((run) => state(pairing, run)))
}

/**
 * Get the state of a run that can open, as JSON.
 *
 * @param {Pairing} pairing
 *   State of pairing.
 * @param {Run} run
 *   Run.
 * @returns {string}
 *   State.
 */
function entry(pairing, run) {
  return JSON.stringify(state(pairing, run))
}

/**
 * Get the state of a run that can open.
 *
 * @param {Pairing} pairing
 *   State of pairing.
 * @param {Run} run
 *   Run.
 * @returns {[number, number, boolean, Array<number>, Array<Array<number> | 0 | undefined>]}
 *   State.
 */
function state(pairing, run) {
  return [
    run.start,
    run.end,
    run.close,
    run.markers,
    // `0` for the sequences of the run, which most sequences start with.
    run.tokens.map((at) => {
      const list = pairing.wrong.get(at)
      return list === run.tokens ? 0 : list
    })
  ]
}

/**
 * Pair the run that starts at a token.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} lane
 *   Marker.
 * @param {Pairing} pairing
 *   State of pairing, changed.
 * @param {number} index
 *   First sequence of the run.
 * @returns {number}
 *   Index after the run.
 */
function step(serialization, lane, pairing, index) {
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
    pairing.wrong.set(at, run.tokens)
    let size = values[at].length
    while (size--) run.markers.push(at)
  }

  run.end = run.markers.length
  pair(serialization, lane, pairing, run)

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
 * Create a tree.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} value
 *   Value of each node.
 * @returns {Array<number>}
 *   Tree.
 */
function tree(serialization, value) {
  /** @type {Array<number>} */
  const nodes = []
  while (nodes.length < serialization.size * 2) nodes.push(value)
  return nodes
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

  if (typeof item === 'string') {
    /** @type {Token} */
    const token = {value: item}

    // If attention before had to encode the character after it, encode it.
    if (before && typeof before.item !== 'string' && before.closeOutside) {
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
  const inside = {value: last ? last.head : ''}

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
