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
 * Tree of nothing: of tokens that pairing did not reach.
 *
 * @type {Tree}
 */
const empty = {
  large: -Infinity,
  left: undefined,
  list: undefined,
  low: Infinity,
  patch: undefined,
  right: undefined,
  small: Infinity,
  state: undefined,
  wrong: Infinity
}

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
 * What runs aggregate to without runs.
 */
const none = {
  large: -Infinity,
  least: -Infinity,
  most: Infinity,
  small: Infinity
}

/**
 * @typedef Pairing
 *   State of pairing runs of a marker like `micromark`.
 * @property {number} count
 *   Runs paired since the last compare.
 * @property {number} decided
 *   First sequence that the last run decided does not form its attention.
 * @property {number} first
 *   First sequence decided that does not form its attention.
 * @property {number} index
 *   Token where pairing is.
 * @property {Array<number> | undefined} involved
 *   Sequences involved with `decided`.
 * @property {number | undefined} kind
 *   Kind of the last run, if it looked at all runs that can open.
 * @property {Array<Tree>} leaves
 *   What pairing keeps at each token from `start`.
 * @property {Array<number> | undefined} list
 *   Sequences involved with `first`.
 * @property {number} low
 *   First sequence of the lowest run that the last run paired with to close.
 * @property {Array<Run>} pending
 *   Runs that can open, in order.
 * @property {Array<Entry>} stack
 *   Snapshots of the first runs that can open, which later snapshots share.
 * @property {number} start
 *   Token of the first of `leaves`.
 * @property {Snapshot | undefined} state
 *   Snapshot at `index`, while trying.
 * @property {Map<number, Array<number>>} wrong
 *   Sequences that do not (yet) form their attention,
 *   with the sequences involved.
 */

/**
 * @typedef Patch
 *   Change to snapshots,
 *   where a try changed only runs that later runs do not look at:
 *   those runs, before `cut`, are replaced by the runs of `add` from `floor`,
 *   on the runs that `under` adds.
 * @property {Snapshot} add
 *   Runs.
 * @property {number} cut
 *   First sequence of the runs that stay.
 * @property {number} floor
 *   First sequence of the runs of `add` that are added.
 * @property {Patch | undefined} under
 *   Patch whose added runs are before these, if any.
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
 * @property {Array<number>} sizes
 *   Markers of each sequence.
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
 * @property {Array<number>} changes
 *   Tree of the last try that changed each token and was kept:
 *   each node has the largest of its two children, leaves are last.
 * @property {number} found
 *   First sequence after the mistake that a try paired and that does not
 *   form its attention.
 * @property {boolean} hollow
 *   Whether there is attention without content, which never forms.
 * @property {Array<unknown> | undefined} log
 *   Changes made by a try, to undo them: object, key, and old value.
 * @property {Array<string>} markers
 *   Markers that sequences can use.
 *   Runs of different markers do not affect each other,
 *   so each pairs on its own.
 * @property {Array<Map<number, Array<Seen>>>} memos
 *   For each marker,
 *   snapshots of versions at tokens after what tries changed,
 *   from which pairing goes as in that version while the tokens after are as
 *   they were.
 * @property {number} mistake
 *   Mistake while trying, or `-1`.
 * @property {Array<Node>} queue
 *   Nodes to render again.
 * @property {number} size
 *   Leaves of trees: a power of two above the count of tokens.
 * @property {number} time
 *   Count of tries.
 * @property {boolean} trying
 *   Whether there is a mistake,
 *   so that pairing keeps what tries need.
 * @property {Array<string>} values
 *   Value of each token.
 * @property {Array<Version>} versions
 *   What is known of pairing, for each marker.
 * @property {boolean} worse
 *   Whether a try made a sequence up to the mistake not form.
 */

/**
 * @typedef Entry
 *   Run that can open, in a snapshot.
 * @property {Snapshot} below
 *   Runs before it.
 * @property {boolean} close
 *   Whether it can close.
 * @property {Data} data
 *   State of the run.
 * @property {number} depth
 *   Runs before it, counted.
 * @property {Snapshot} jump
 *   Run further before it, to find runs in logarithmic time
 *   (Myers, “An applicative random-access stack”).
 * @property {number} large
 *   Largest size of it and the runs before it.
 * @property {number} least
 *   Smallest kind of runs that do not skip it and the runs before it.
 * @property {number} most
 *   Largest kind of runs that do not skip it and the runs before it.
 * @property {number} size
 *   Markers left.
 * @property {number} small
 *   Smallest size of it and the runs before it.
 * @property {number} token
 *   Its first sequence.
 */

/**
 * @typedef {[number, number, boolean, Array<number>, Array<Array<number> | 0 | null>]} Data
 *   State of a run that can open:
 *   its `start`, `end`, `close`, `sizes`,
 *   and the sequences involved with each of its sequences, if wrong
 *   (`0` if those are the sequences of the run), or `null`.
 */

/**
 * @typedef {Entry | null} Snapshot
 *   State of pairing at a token: the last run that can open, or `null`.
 */

/**
 * @typedef Token
 *   Rendered phrasing.
 * @property {string} value
 *   Value.
 */

/**
 * @typedef Tree
 *   Node of a tree of what pairing keeps at each token, for a marker:
 *   each node has the smallest (or largest) value of its two children,
 *   leaves are tokens.
 *   Versions share nodes, which do not change.
 * @property {number} large
 *   Largest kind of the runs that look at all runs that can open,
 *   where the kind is how many markers are left modulo 3,
 *   times 2, plus whether it can open,
 *   or, for other markers, its size,
 *   or `-Infinity`.
 * @property {Tree | undefined} left
 *   First half.
 * @property {Array<number> | undefined} list
 *   Sequences involved with `wrong`.
 * @property {number} low
 *   First sequence of the lowest run that a run pairs with to close,
 *   or `Infinity`.
 * @property {Patch | undefined} patch
 *   Change to the snapshots of the leaves.
 * @property {Tree | undefined} right
 *   Second half.
 * @property {number} small
 *   Smallest kind, like `large`, or `Infinity`.
 * @property {Snapshot | undefined} state
 *   Snapshot before the token, of a leaf, if not in the middle of a run.
 * @property {number} wrong
 *   First sequence that a run decides does not form its attention,
 *   or `Infinity`.
 */

/**
 * @typedef {Data | Data[number] | Data[4][number]} Value
 *   Value in the state of a run.
 */

/**
 * @typedef Version
 *   What is known of pairing a marker, after a try.
 * @property {[number, Array<number> | undefined]} end
 *   First sequence open at the end, if known, and the sequences involved.
 * @property {number} known
 *   Index up to which pairing is known.
 * @property {number} time
 *   Try.
 * @property {Tree} tree
 *   What pairing keeps.
 */

/**
 * @typedef Seen
 *   Snapshot of a version at a token.
 * @property {Snapshot} state
 *   Snapshot.
 * @property {Version} version
 *   Version.
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
 * and keeps the state of pairing at each token,
 * so that a try can pair again from there.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @returns {[number, Array<number>] | undefined}
 *   First sequence that does not form its attention, and the sequences
 *   involved, if any.
 */
function check(serialization) {
  const {markers, values, versions} = serialization
  const length = values.length
  const pairings = versions.map(({known, tree}) =>
    restore(
      serialization,
      known,
      // Nothing is open at the start, and everything is decided at the end.
      known && known < length
        ? /** @type {Snapshot} */ (read(serialization, tree, known))
        : null
    )
  )
  let [first, list] = [
    Infinity,
    /** @type {Array<number> | undefined} */ (undefined)
  ]

  for (const version of versions) {
    const [at, involved] = wrongs(serialization, version)
    if (at < first) [first, list] = [at, involved]
  }

  while (true) {
    // Sequences before `frontier` are done pairing, for every marker.
    let frontier = length
    let behind = -1
    let lane = -1

    while (++lane < markers.length) {
      const pairing = pairings[lane]
      if (pairing.first < first) [first, list] = [pairing.first, pairing.list]
      const bound = Math.min(pairing.index, undone(pairing))

      if (!(bound < frontier)) {
        continue
      }

      frontier = bound
      behind = lane
    }

    if (first < frontier || behind === -1) break

    // Pair further for the marker that is behind.
    const pairing = pairings[behind]
    const version = versions[behind]
    advance(serialization, behind, pairing)
    const {index} = pairing

    if (!serialization.trying || index === length) continue
    remember(
      serialization,
      behind,
      index,
      /** @type {Snapshot} */ (pairing.state),
      version
    )

    // Pair as a version that paired from here did, as in `attempt`.
    if (pairing.count < pairing.pending.length) continue
    pairing.count = 0
    const found = choose(
      serialization,
      behind,
      pairing,
      valid(serialization, behind, index, undefined),
      Infinity
    )

    if (!found) continue
    flush(serialization, version, pairing)
    const moved = move(serialization, version, pairing, found)
    pairings[behind] = moved
    // What it decided does not form, up to where it is now.
    const [at, involved] = wrongs(serialization, {
      ...version,
      known: moved.index
    })
    if (at < first) [first, list] = [at, involved]
  }

  for (const [lane, pairing] of pairings.entries()) {
    flush(serialization, versions[lane], pairing)
    versions[lane].known = pairing.index
  }

  return list ? [first, list] : undefined
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
 * @param {Array<number>} involved
 *   Sequences involved.
 * @returns {boolean}
 *   Whether that worked.
 */
function improve(serialization, mistake, involved) {
  for (const node of candidates(serialization, involved)) {
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
 * from the state of pairing there,
 * until the state of pairing is as in a version,
 * except for runs that version does not look at for a while,
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
  const {markers, values, versions} = serialization
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
  const time = ++serialization.time
  serialization.mistake = mistake
  serialization.worse = false
  // Once pairing is past the closing sequence of the mistake,
  // it formed or never will.
  const settled = /** @type {Node} */ (serialization.attentions[mistake]).close
  /** @type {Array<Version>} */
  const made = []
  let lane = -1

  while (++lane < markers.length && !serialization.worse) {
    const old = versions[lane]
    /** @type {Version} */
    const version = {...old, time}
    let next = 0
    made.push(version)
    serialization.found = Infinity

    while (
      next < changed.length &&
      changed[next] <= version.known &&
      !serialization.worse
    ) {
      // Start before the token before the change,
      // as the run with that token can open or close depending on it.
      let index = Math.max(changed[next] - 1, 0)
      /** @type {Snapshot | undefined} */
      let state = null

      while (
        index > 0 &&
        (state = read(serialization, version.tree, index)) === undefined
      ) {
        index--
      }

      let pairing = restore(serialization, index, state || null)

      while (!serialization.worse) {
        advance(serialization, lane, pairing)
        index = pairing.index

        if (index > settled && pairing.wrong.get(mistake) !== undefined) {
          serialization.worse = true
          break
        }

        while (next < changed.length && changed[next] < index - 1) next++
        // Where the tokens after are as when a version paired from here,
        // and pairing is as in it, the rest pairs as in it.
        const after = next === changed.length
        if (after && index < length) {
          remember(
            serialization,
            lane,
            index,
            /** @type {Snapshot} */ (pairing.state),
            version
          )
        }

        // A compare takes as long as the runs that can open,
        // so compare once as many runs paired.
        // At the end, pairing stops anyway.
        if (
          index < length &&
          (after || changed[next] > index) &&
          pairing.count >= pairing.pending.length
        ) {
          pairing.count = 0
          const current =
            index <= old.known
              ? read(serialization, old.tree, index)
              : undefined
          /** @type {Array<Seen>} */
          const seen =
            current === undefined ? [] : [{state: current, version: old}]
          if (after) seen.push(...valid(serialization, lane, index, old))
          const found = choose(
            serialization,
            lane,
            pairing,
            seen,
            after ? Infinity : changed[next] - 1
          )

          if (found) {
            const [use, to] = found
            flush(serialization, version, pairing)
            if (to === Infinity && use.version === old) break
            pairing = move(serialization, version, pairing, found)
            if (to !== Infinity && pairing.index < length) continue
          }
        }

        // Stop once sequences up to the mistake are done pairing,
        // where pairing is not known,
        // or where the next mistake is known.
        index = pairing.index
        const done = index > mistake && undone(pairing) > mistake

        if (
          index === length ||
          (done &&
            (index >= version.known ||
              (after && serialization.found < undone(pairing))))
        ) {
          version.known = index
          next = changed.length
          break
        }
      }

      // Pairing is known up to where it stopped.
      if (serialization.worse) version.known = pairing.index

      flush(serialization, version, pairing)
    }
  }

  serialization.log = undefined
  serialization.mistake = -1

  // Better if the mistake now forms, and nothing before it does not.
  for (const version of made) {
    if (wrongs(serialization, version)[0] <= mistake) serialization.worse = true
  }

  if (serialization.worse) {
    let index = log.length

    while (index > 0) {
      index -= 3
      const object = /** @type {Record<PropertyKey, unknown>} */ (log[index])
      object[/** @type {PropertyKey} */ (log[index + 1])] = log[index + 2]
    }

    return false
  }

  for (const at of changed) {
    put(serialization, serialization.changes, at, time, Math.max)
  }

  serialization.versions = made
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
    // Snapshots of this run and those after it change.
    pairing.stack.length = Math.min(pairing.stack.length, open)
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
        decide(serialization, pairing, at, wrong.get(at))
      }
    }

    if (opener.start === opener.end) pending.splice(open, 1)

    // Search again from the start, as this run may close more.
    open = pending.length
  }

  const kind = ((closer.end - closer.start) % 3) * 2
  pairing.low = low
  // Left after looking at all runs.
  pairing.kind =
    closer.close && closer.start < closer.end
      ? split
        ? kind + Number(closer.open)
        : closer.end - closer.start
      : undefined
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
    changes: [],
    found: Infinity,
    hollow: false,
    log: undefined,
    markers: [],
    memos: [],
    mistake: -1,
    queue: [],
    size: 1,
    time: 0,
    trying: false,
    values: [],
    versions: [],
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
        serialization.versions.push({
          end: [Infinity, undefined],
          known: 0,
          time: 0,
          tree: empty
        })
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

  let mistake = check(serialization)
  if (!mistake) return initial
  plant(serialization)
  mistake = check(serialization)

  while (mistake) {
    if (!improve(serialization, ...mistake)) return initial
    mistake = check(serialization)
  }

  return serialization.values.join('')
}

/**
 * Pair the run at a token, if it is one of a marker,
 * or move past tokens up to the next run of it.
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
  const {trying, values} = serialization
  const marker = serialization.markers[lane]
  const {leaves} = pairing

  if (isMarker(serialization, pairing.index, marker)) {
    pairing.decided = Infinity
    const end = step(serialization, lane, pairing, pairing.index)

    if (trying) {
      leaves.push(
        leaf(
          pairing.state,
          pairing.low,
          pairing.kind,
          pairing.decided,
          pairing.involved
        )
      )
      while (pairing.start + leaves.length < end) leaves.push(empty)
      pairing.state = snapshot(pairing)
    }

    pairing.index = end
    pairing.count++
  } else {
    const skip = leaf(pairing.state, Infinity, undefined, Infinity, undefined)

    // Move past tokens of other markers or strings at once,
    // or one at a time while trying, as the rest may pair as before.
    do {
      if (trying) leaves.push(skip)
      pairing.index++
    } while (
      pairing.index < values.length &&
      serialization.mistake === -1 &&
      !isMarker(serialization, pairing.index, marker)
    )
  }

  // At the end, what is still open does not form.
  if (pairing.index === values.length) {
    pairing.decided = Infinity

    for (const run of pairing.pending) {
      for (const at of run.tokens) {
        decide(serialization, pairing, at, pairing.wrong.get(at))
      }
    }

    pairing.pending = []
    pairing.stack = []
  }
}

/**
 * Note that a sequence does not form its attention, if so.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Pairing} pairing
 *   State of pairing, changed.
 * @param {number} at
 *   Token.
 * @param {Array<number> | undefined} list
 *   Sequences involved, if wrong.
 * @returns {undefined}
 *   Nothing.
 */
function decide(serialization, pairing, at, list) {
  if (!list) return
  if (at <= serialization.mistake) serialization.worse = true
  else serialization.found = Math.min(serialization.found, at)

  if (at < pairing.first) {
    pairing.first = at
    pairing.list = list
  }

  if (at < pairing.decided) {
    pairing.decided = at
    pairing.involved = list
  }
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
 * Keep what pairing kept since it started or since the last flush in a
 * version.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Version} version
 *   Version, changed.
 * @param {Pairing} pairing
 *   State of pairing, changed.
 * @returns {undefined}
 *   Nothing.
 */
function flush(serialization, version, pairing) {
  if (pairing.index === pairing.start || !serialization.trying) return
  // The state where pairing is.
  pairing.leaves.push(
    leaf(pairing.state, Infinity, undefined, Infinity, undefined)
  )
  version.tree = replace(
    version.tree,
    0,
    serialization.size,
    pairing.start,
    pairing.leaves
  )
  if (pairing.index === serialization.values.length) {
    version.end = [pairing.decided, pairing.involved]
  }

  pairing.leaves = []
  pairing.start = pairing.index
}

/**
 * Find a version that paired from where pairing is,
 * to pair as it did, as far as possible.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} lane
 *   Marker.
 * @param {Pairing} pairing
 *   State of pairing.
 * @param {Array<Seen>} seen
 *   Snapshots of versions where pairing is.
 * @param {number} bound
 *   Last token that pairs as before.
 * @returns {[Seen, number, Patch | undefined] | undefined}
 *   Version, last token that pairs as in it (`Infinity` if all do),
 *   and patch to it.
 */
function choose(serialization, lane, pairing, seen, bound) {
  const split = builtins.has(serialization.markers[lane])
  const {index} = pairing
  const length = serialization.values.length
  const here = /** @type {Snapshot} */ (pairing.state)
  let to = index
  /** @type {Seen | undefined} */
  let use
  /** @type {Patch | undefined} */
  let patch

  for (const other of seen) {
    const common = same(other.state, here)

    if (common === -1) {
      use = other
      patch = undefined
      to = Infinity
      break
    }

    // Runs that differ pair with nothing until a later run pairs
    // with one of them before,
    // or looks at all of them while it does not skip each of them,
    // following the rule of 3 in `pair`,
    // or, for other markers, while it is of the size of one of them:
    // until then, pair as in the version, with those runs as they are.
    const {pending} = pairing
    const cut = common > 0 ? pending[pending.length - common].tokens[0] : index
    const add =
      common < pending.length
        ? pairing.stack[pending.length - common - 1]
        : null
    const {large, least, most, small} = add || none
    // Kinds that are fine, or, for other markers, sizes that are not.
    const low = split ? least : small
    const high = split ? most : large

    const {known, tree} = other.version
    const far = Math.min(
      reach(serialization, lane, tree, index, cut, low, high),
      bound
    )
    // Nothing pairs with them until the end, where they do not form.
    let end =
      far === Infinity && known === length
        ? length
        : Math.min(far, known, length - 1)

    while (
      end > index &&
      end < length &&
      read(serialization, tree, end) === undefined
    ) {
      end--
    }

    if (end <= to) continue
    to = end
    use = other
    patch = {
      add,
      cut,
      floor: -Infinity,
      under: undefined
    }
  }

  return use ? [use, to, patch] : undefined
}

/**
 * Pair as a version did.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Version} version
 *   Version, changed.
 * @param {Pairing} pairing
 *   State of pairing, which this takes runs from.
 * @param {[Seen, number, Patch | undefined]} found
 *   Version, last token that pairs as in it (`Infinity` if all do),
 *   and patch to it.
 * @returns {Pairing}
 *   State of pairing after.
 */
function move(serialization, version, pairing, found) {
  const {index} = pairing
  const [use, to, patch] = found
  const length = serialization.values.length
  const end = to === Infinity ? use.version.known : to
  version.tree = splice(
    serialization,
    version.tree,
    use.version.tree,
    index,
    end + 1,
    patch
  )

  if (to === Infinity) {
    version.end = use.version.end
    version.known = end
  } else if (end === length) {
    version.end = ending(serialization, version.tree)
  }

  if (end === length) return restore(serialization, end, null)
  const state = /** @type {Snapshot} */ (read(serialization, version.tree, end))
  // Runs that differ are as they were.
  return patch
    ? restore(serialization, end, state, pairing, patch.cut)
    : restore(serialization, end, state)
}

/**
 * Get the snapshots of other versions at a token that pair as they did.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} lane
 *   Marker.
 * @param {number} index
 *   Token.
 * @param {Version | undefined} version
 *   Version to leave out.
 * @returns {Array<Seen>}
 *   Snapshots.
 */
function valid(serialization, lane, index, version) {
  // Where no change at or after the token before is kept since a version,
  // pairing from there is as in it.
  // Versions of this time are still pairing.
  // Pairing noted itself here already.
  const time = latest(serialization, index - 1)
  const memo = /** @type {Array<Seen>} */ (serialization.memos[lane].get(index))
  return memo.filter(
    (other) =>
      other.version !== version &&
      time <= other.version.time &&
      other.version.time < serialization.time
  )
}

/**
 * Get what a version decides at the end does not form its attention:
 * the first sequence of the lowest run that is open there.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Tree} tree
 *   Tree of a version.
 * @returns {[number, Array<number> | undefined]}
 *   Sequence, or `Infinity`, and the sequences involved.
 */
function ending(serialization, tree) {
  const [state, patch] = locate(
    serialization,
    tree,
    serialization.values.length
  )
  /** @type {Snapshot} */
  let run = null

  // The lowest run that a patch adds, or else of the snapshot.
  // This is called after a patch to the end.
  for (
    let layer = /** @type {Patch | undefined} */ (patch);
    layer;
    layer = layer.under
  ) {
    if (layer.add) run = lowest(layer.add, layer.floor)
  }

  run ||= lowest(
    /** @type {Snapshot} */ (state),
    /** @type {Patch} */ (patch).cut
  )
  if (!run) return [Infinity, undefined]
  const pairing = restore(serialization, 0, {...run, below: null})
  const at = undone(pairing)
  return [at, pairing.wrong.get(at)]
}

/**
 * Add a run to a snapshot.
 *
 * @param {Snapshot} below
 *   Snapshot.
 * @param {Pick<Entry, 'data' | 'token'>} run
 *   Run.
 * @returns {Entry}
 *   Snapshot.
 */
function link(below, run) {
  const {data, token} = run
  const close = data[2]
  const size = data[1] - data[0]
  const left = size % 3
  // Skipped by runs with `3 - left` left that can open,
  // or that cannot if it can close, as in `pair`.
  const kind = (3 - left) * 2
  let jump = below

  if (
    below &&
    below.jump &&
    below.jump.jump &&
    below.depth - below.jump.depth === below.jump.depth - below.jump.jump.depth
  ) {
    jump = below.jump.jump
  }

  return {
    below,
    close,
    data,
    depth: below ? below.depth + 1 : 0,
    jump,
    large: Math.max(below ? below.large : -Infinity, size),
    least: Math.max(
      below ? below.least : -Infinity,
      left ? (close ? kind : kind + 1) : Infinity
    ),
    most: Math.min(below ? below.most : Infinity, left ? kind + 1 : Infinity),
    size,
    small: Math.min(below ? below.small : Infinity, size),
    token
  }
}

/**
 * Find the first run from a token that pairs with a run before another token,
 * or looks at all runs while it is not of some kinds,
 * or, for other markers, while it is of some sizes.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} lane
 *   Marker.
 * @param {Tree} tree
 *   Tree of a version.
 * @param {number} from
 *   Token to search from.
 * @param {number} below
 *   Token.
 * @param {number} low
 *   Smallest kind that is fine, or size that is not for other markers.
 * @param {number} high
 *   Largest kind that is fine, or size that is not for other markers.
 * @returns {number}
 *   First sequence of that run, or `Infinity`.
 */
function reach(serialization, lane, tree, from, below, low, high) {
  const split = builtins.has(serialization.markers[lane])
  /**
   * Check a node.
   *
   * @param {Tree} node
   *   Node.
   * @returns {boolean}
   *   Whether a leaf under it is such a run.
   */
  const hit = (node) =>
    node.low < below ||
    (split
      ? node.small < low || node.large > high
      : node.small <= high && node.large >= low)

  return find(tree, 0, serialization.size)

  /**
   * Find in a node.
   *
   * @param {Tree} node
   *   Node.
   * @param {number} start
   *   First token of it.
   * @param {number} end
   *   Token after it.
   * @returns {number}
   *   Token, or `Infinity`.
   */
  function find(node, start, end) {
    if (end <= from || !hit(node)) return Infinity
    if (end - start === 1) return start
    const middle = (start + end) / 2
    // Nodes with runs have two halves.
    const left = find(/** @type {Tree} */ (node.left), start, middle)
    return left === Infinity
      ? find(/** @type {Tree} */ (node.right), middle, end)
      : left
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
 * Create a node of a tree.
 *
 * @param {Tree} left
 *   First half.
 * @param {Tree} right
 *   Second half.
 * @returns {Tree}
 *   Node.
 */
function join(left, right) {
  const first = right.wrong < left.wrong ? right : left
  return {
    large: Math.max(left.large, right.large),
    left,
    list: first.list,
    low: Math.min(left.low, right.low),
    patch: undefined,
    right,
    small: Math.min(left.small, right.small),
    state: undefined,
    wrong: first.wrong
  }
}

/**
 * Get the last kept try that changed a token from some token on.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} from
 *   Token.
 * @returns {number}
 *   Try.
 */
function latest(serialization, from) {
  const {changes, size} = serialization
  let index = size + Math.max(from, 0)
  let value = changes[index]

  while (index > 1) {
    // Add the second half next to it.
    if (index % 2 === 0) value = Math.max(value, changes[index + 1])
    index = Math.floor(index / 2)
  }

  return value
}

/**
 * Create a leaf of a tree.
 *
 * @param {Snapshot | undefined} state
 *   Snapshot before the token, if not in the middle of a run.
 * @param {number} low
 *   First sequence of the lowest run that the run pairs with to close.
 * @param {number | undefined} kind
 *   Kind of the run, if it looks at all runs that can open.
 * @param {number} wrong
 *   First sequence that the run decides does not form its attention.
 * @param {Array<number> | undefined} list
 *   Sequences involved with it.
 * @returns {Tree}
 *   Leaf.
 */
function leaf(state, low, kind, wrong, list) {
  return {
    large: kind ?? -Infinity,
    left: undefined,
    list,
    low,
    patch: undefined,
    right: undefined,
    small: kind ?? Infinity,
    state,
    wrong
  }
}

/**
 * Add the runs of a snapshot from a sequence on, in order.
 *
 * @param {Snapshot} state
 *   Snapshot.
 * @param {number} cut
 *   First sequence.
 * @param {Array<Entry>} runs
 *   Runs, changed.
 * @returns {undefined}
 *   Nothing.
 */
function take(state, cut, runs) {
  const start = runs.length

  while (state && state.token >= cut) {
    runs.push(state)
    state = state.below
  }

  // From the last run, so turn them around.
  let low = start
  let high = runs.length - 1

  while (low < high) {
    const run = runs[low]
    runs[low++] = runs[high]
    runs[high--] = run
  }
}

/**
 * Patch a snapshot.
 *
 * @param {Snapshot} state
 *   Snapshot.
 * @param {Patch} patch
 *   Patch.
 * @returns {Snapshot}
 *   Snapshot.
 */
function apply(state, patch) {
  /** @type {Array<Patch>} */
  const layers = []
  /** @type {Array<Entry>} */
  const runs = []
  /** @type {Snapshot} */
  let result = null

  for (
    let layer = /** @type {Patch | undefined} */ (patch);
    layer;
    layer = layer.under
  ) {
    if (layer.add) layers.push(layer)
  }

  let index = layers.length
  // The lowest runs, if all are added, are shared.
  if (index && layers[index - 1].floor === -Infinity)
    result = layers[--index].add
  while (index--) take(layers[index].add, layers[index].floor, runs)
  take(state, patch.cut, runs)
  for (const run of runs) result = link(result, run)
  return result
}

/**
 * Get a half of a node, with the patch of the node.
 *
 * @param {Tree} node
 *   Node.
 * @param {Tree | undefined} half
 *   Half.
 * @returns {Tree}
 *   Half, patched.
 */
function child(node, half) {
  const result = half || empty
  return node.patch ? patched(result, node.patch) : result
}

/**
 * Get a patch that does what two patches do.
 *
 * @param {Patch | undefined} inner
 *   Patch done first.
 * @param {Patch} outer
 *   Patch done next.
 * @returns {Patch}
 *   Patch.
 */
function compose(inner, outer) {
  // The runs an inner patch adds are before its cut,
  // so they stay only if the outer cut is lower.
  if (!inner || inner.cut <= outer.cut) return outer
  // Linking runs takes long, so this keeps the runs of both in layers.
  return {...trim(inner, outer.cut, outer), cut: inner.cut}
}

/**
 * Drop the runs that a patch adds before a sequence,
 * and add the runs of another patch below them.
 *
 * @param {Patch} patch
 *   Patch.
 * @param {number} cut
 *   Sequence.
 * @param {Patch} bottom
 *   Patch.
 * @returns {Patch}
 *   Patch.
 */
function trim(patch, cut, bottom) {
  const floor = Math.max(patch.floor, cut)
  // Runs are in order, so a patch without runs from the cut adds none below.
  if (!patch.add || patch.add.token < floor) return bottom
  return {
    ...patch,
    floor,
    under: patch.under ? trim(patch.under, cut, bottom) : bottom
  }
}

/**
 * Find the lowest run of a snapshot from a sequence.
 *
 * @param {Snapshot} state
 *   Snapshot.
 * @param {number} cut
 *   Sequence.
 * @returns {Snapshot}
 *   Run, if any.
 */
function lowest(state, cut) {
  if (!state || state.token < cut) return null
  let run = state

  // Runs are in order, so skip down.
  while (true) {
    if (run.jump && run.jump.token >= cut) run = run.jump
    else if (run.below && run.below.token >= cut) run = run.below
    else return run
  }
}

/**
 * Patch the snapshots of a node.
 *
 * @param {Tree} node
 *   Node.
 * @param {Patch} patch
 *   Patch.
 * @returns {Tree}
 *   Node.
 */
function patched(node, patch) {
  return {...node, patch: compose(node.patch, patch)}
}

/**
 * Get the snapshot of a version at a token.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Tree} tree
 *   Tree.
 * @param {number} at
 *   Token.
 * @returns {Snapshot | undefined}
 *   Snapshot, if there is one.
 */
function read(serialization, tree, at) {
  const [state, patch] = locate(serialization, tree, at)
  return patch && state !== undefined ? apply(state, patch) : state
}

/**
 * Get the snapshot of a version at a token, and the patch to it.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Tree} tree
 *   Tree.
 * @param {number} at
 *   Token.
 * @returns {[Snapshot | undefined, Patch | undefined]}
 *   Snapshot, if there is one, and patch.
 */
function locate(serialization, tree, at) {
  /** @type {Patch | undefined} */
  let patch
  let node = tree
  let start = 0
  let size = serialization.size

  while (true) {
    // Patches of nodes further down are done first.
    if (node.patch) patch = patch ? compose(node.patch, patch) : node.patch
    if (size === 1) break
    size /= 2

    if (at < start + size) {
      node = /** @type {Tree} */ (node.left)
    } else {
      node = /** @type {Tree} */ (node.right)
      start += size
    }
  }

  return [node.state, patch]
}

/**
 * Note the snapshot of a version at a token.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} lane
 *   Marker.
 * @param {number} index
 *   Token.
 * @param {Snapshot} state
 *   Snapshot.
 * @param {Version} version
 *   Version.
 * @returns {undefined}
 *   Nothing.
 */
function remember(serialization, lane, index, state, version) {
  const memo = serialization.memos[lane]
  let seen = memo.get(index)

  if (!seen) {
    seen = []
    memo.set(index, seen)
  }

  seen.push({state, version})
  // Versions that pair the same from a token are often a few tries apart.
  if (seen.length > 8) seen.shift()
}

/**
 * Get a tree with other leaves.
 *
 * @param {Tree} node
 *   Node.
 * @param {number} start
 *   First token of it.
 * @param {number} end
 *   Token after it.
 * @param {number} from
 *   Token of the first leaf.
 * @param {Array<Tree>} leaves
 *   Leaves.
 * @returns {Tree}
 *   Node.
 */
function replace(node, start, end, from, leaves) {
  const to = from + leaves.length
  if (end <= from || to <= start) return node
  if (end - start === 1) return leaves[start - from]
  const middle = (start + end) / 2
  // Patches change leaves that stay, so move them down.
  const inside = from <= start && end <= to
  return join(
    replace(
      inside ? empty : child(node, node.left),
      start,
      middle,
      from,
      leaves
    ),
    replace(inside ? empty : child(node, node.right), middle, end, from, leaves)
  )
}

/**
 * Get the state of pairing of a snapshot.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} index
 *   Token of the snapshot.
 * @param {Snapshot} state
 *   Snapshot.
 * @param {Pairing | undefined} [from]
 *   State of pairing whose runs before `cut` are those of the snapshot.
 * @param {number} [cut]
 *   Sequence.
 * @returns {Pairing}
 *   State of pairing.
 */
function restore(serialization, index, state, from, cut = -Infinity) {
  /** @type {Pairing} */
  const pairing = {
    count: Infinity,
    decided: Infinity,
    first: Infinity,
    index,
    involved: undefined,
    kind: undefined,
    leaves: [],
    list: undefined,
    low: Infinity,
    pending: from ? from.pending : [],
    stack: from ? from.stack : [],
    start: index,
    state,
    wrong: from ? from.wrong : new Map()
  }
  const {pending, stack, wrong} = pairing

  // Keep the runs before the cut, so this takes as long as the runs after.
  while (pending.length > 0 && pending[pending.length - 1].tokens[0] >= cut) {
    for (const at of /** @type {Run} */ (pending.pop()).tokens) wrong.delete(at)
  }

  stack.length = pending.length
  // Runs that can still open, which snapshots after this share.
  take(state, cut, stack)

  for (const run of stack.slice(pending.length)) {
    const [start, end, close, sizes, lists] = run.data
    /** @type {Array<number>} */
    const markers = []
    const tokens = sizes.map((size, index) => {
      const at = run.token + index
      while (size--) markers.push(at)
      return at
    })
    pairing.pending.push({
      close,
      end,
      markers,
      // Pending runs can open, `pair` checks this on closers only.
      open: true,
      sizes,
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
 * Check whether two values of the state of runs are the same.
 *
 * @param {Value} a
 *   Value.
 * @param {Value} b
 *   Value.
 * @returns {boolean}
 *   Whether they are.
 */
function alike(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false
  }

  let index = -1

  while (++index < a.length) {
    if (!alike(a[index], b[index])) return false
  }

  return true
}

/**
 * Count how many runs at the end of two snapshots are the same.
 *
 * @param {Snapshot} a
 *   Snapshot.
 * @param {Snapshot} b
 *   Snapshot.
 * @returns {number}
 *   Runs, or `-1` if all are.
 */
function same(a, b) {
  let count = 0

  // Snapshots share runs before some run.
  while (a !== b) {
    if (!a || !b || a.token !== b.token || !alike(a.data, b.data)) return count
    a = a.below
    b = b.below
    count++
  }

  return -1
}

/**
 * Forget pairing and create what tries use,
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

  serialization.changes = Array.from({length: serialization.size * 2}, () => 0)
  serialization.memos = serialization.markers.map(() => new Map())
  serialization.trying = true
  serialization.versions = serialization.markers.map(() => ({
    end: [Infinity, undefined],
    known: 0,
    time: 0,
    tree: empty
  }))
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
function put(serialization, tree, at, value, combine) {
  let index = serialization.size + at

  while (write(serialization, tree, index, value) && index > 1) {
    index = Math.floor(index / 2)
    const left = index * 2
    value = combine(tree[left], tree[left + 1])
  }
}

/**
 * Get a tree with the leaves of another tree from a token to another,
 * patched.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Tree} tree
 *   Tree.
 * @param {Tree} source
 *   Other tree.
 * @param {number} from
 *   First token.
 * @param {number} to
 *   Token after the last.
 * @param {Patch | undefined} patch
 *   Patch.
 * @returns {Tree}
 *   Tree.
 */
function splice(serialization, tree, source, from, to, patch) {
  return part(tree, source, 0, serialization.size)

  /**
   * Splice a node.
   *
   * @param {Tree} node
   *   Node.
   * @param {Tree} other
   *   Node of the other tree.
   * @param {number} start
   *   First token of it.
   * @param {number} end
   *   Token after it.
   * @returns {Tree}
   *   Node.
   */
  function part(node, other, start, end) {
    if (end <= from || to <= start) return node
    if (from <= start && end <= to) return patch ? patched(other, patch) : other
    const middle = (start + end) / 2
    return join(
      part(child(node, node.left), child(other, other.left), start, middle),
      part(child(node, node.right), child(other, other.right), middle, end)
    )
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
  const {pending, stack} = pairing

  while (stack.length < pending.length) {
    const run = pending[stack.length]
    stack.push(
      link(stack.length === 0 ? null : stack[stack.length - 1], {
        data: describe(pairing, run),
        token: run.tokens[0]
      })
    )
  }

  return stack.length === 0 ? null : stack[stack.length - 1]
}

/**
 * Get the state of a run that can open.
 *
 * Lists of sequences involved are shared.
 *
 * @param {Pairing} pairing
 *   State of pairing.
 * @param {Run} run
 *   Run.
 * @returns {Data}
 *   State.
 */
function describe(pairing, run) {
  return [
    run.start,
    run.end,
    run.close,
    run.sizes,
    // `0` for the sequences of the run, which most sequences start with.
    run.tokens.map((at) => {
      const list = pairing.wrong.get(at)
      return list === run.tokens ? 0 : list || null
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
    sizes: [],
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
    run.sizes.push(size)
    while (size--) run.markers.push(at)
  }

  run.end = run.markers.length
  pair(serialization, lane, pairing, run)

  if (run.open && run.start < run.end) {
    pairing.pending.push(run)
  } else {
    for (const at of run.tokens) {
      decide(serialization, pairing, at, pairing.wrong.get(at))
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
 * Get the first sequence that a version decides does not form its attention.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Version} version
 *   Version.
 * @returns {[number, Array<number> | undefined]}
 *   Sequence, or `Infinity`, and the sequences involved.
 */
function wrongs(serialization, version) {
  const {known} = version
  /** @type {[number, Array<number> | undefined]} */
  const result =
    known === serialization.values.length
      ? [...version.end]
      : [Infinity, undefined]
  first(version.tree, 0, serialization.size)
  return result

  /**
   * Find in the leaves of a node before `known`.
   *
   * @param {Tree} node
   *   Node.
   * @param {number} start
   *   First token of it.
   * @param {number} end
   *   Token after it.
   * @returns {undefined}
   *   Nothing.
   */
  function first(node, start, end) {
    if (start >= known || node.wrong >= result[0]) return

    if (end <= known) {
      result[0] = node.wrong
      result[1] = node.list
    } else {
      const middle = (start + end) / 2
      first(/** @type {Tree} */ (node.left), start, middle)
      first(/** @type {Tree} */ (node.right), middle, end)
    }
  }
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
