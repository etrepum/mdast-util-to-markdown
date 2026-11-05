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
 * @typedef List
 *   Set of sequences:
 *   a tree by sequence where the sequence of a node comes before those of its
 *   children by `rank`.
 *   Nodes are shared, so lists of the same sequences are the same.
 * @property {number} at
 *   Sequence.
 * @property {number} id
 *   Number of it.
 * @property {List | undefined} left
 *   Sequences before.
 * @property {number} rank
 *   Priority of it, from `at`.
 * @property {List | undefined} right
 *   Sequences after.
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
  bottom: Infinity,
  large: -Infinity,
  least: -Infinity,
  list: undefined,
  most: Infinity,
  small: Infinity,
  top: -Infinity,
  wrong: Infinity
}

/**
 * @typedef Pairing
 *   State of pairing runs of a marker like `micromark`.
 * @property {number} decided
 *   First sequence that the last run decided does not form its attention.
 * @property {number} first
 *   First sequence decided that does not form its attention.
 * @property {number} index
 *   Token where pairing is.
 * @property {List | undefined} involved
 *   Sequences involved with `decided`.
 * @property {Array<number> | undefined} involvedAdded
 *   Sequences to add to `involved` once the run is done.
 * @property {number | undefined} kind
 *   Kind of the last run, if it looked at all runs that can open.
 * @property {Array<Tree>} leaves
 *   What pairing keeps at each token from `start`.
 * @property {List | undefined} list
 *   Sequences involved with `first`.
 * @property {Array<number> | undefined} listAdded
 *   Sequences to add to `list` once the run is done.
 * @property {number} low
 *   First sequence of the lowest run that the last run paired with to close.
 * @property {number} start
 *   Token of the first of `leaves`.
 * @property {Snapshot} state
 *   Runs that can open; at the end, those that were open there.
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
 * @property {Array<number>} ends
 *   Markers up to the end of each sequence.
 * @property {Array<List | undefined>} lists
 *   Sequences involved with each sequence, if it does not (yet) form its
 *   attention.
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
 * @property {number} count
 *   Count of nodes of snapshots and lists.
 * @property {Map<number, Map<number, Map<number, List>>>} lists
 *   Nodes of lists of sequences, by their sequence and halves.
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
 * @property {Map<string, Data>} runs
 *   States of runs that can open, by what they are.
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
 *   Node of a snapshot:
 *   a tree of the runs that can open, by their first sequence,
 *   where the run of a node comes before those of its children by `rank`.
 *   Nodes are shared, so snapshots of the same runs are the same.
 * @property {number} bottom
 *   Smallest kind of its runs.
 * @property {Data} data
 *   Run.
 * @property {number} first
 *   First sequence of its first run.
 * @property {number} id
 *   Number of it.
 * @property {number} large
 *   Largest size of its runs.
 * @property {number} last
 *   First sequence of its last run.
 * @property {number} least
 *   Smallest kind of runs that do not skip its runs.
 * @property {Snapshot} left
 *   Runs before.
 * @property {List | undefined} list
 *   Sequences involved with `wrong`.
 * @property {number} most
 *   Largest kind of runs that do not skip its runs.
 * @property {Snapshot} right
 *   Runs after.
 * @property {number} small
 *   Smallest size of its runs.
 * @property {number} top
 *   Largest kind of its runs.
 * @property {number} undone
 *   Sequence of the first marker not used of its first run.
 * @property {number} wrong
 *   First sequence of its runs that does not (yet) form its attention,
 *   or `Infinity`.
 */

/**
 * @typedef Data
 *   State of a run that can open, shared by runs in the same state.
 * @property {boolean} close
 *   Whether it can close.
 * @property {number} end
 *   Index after the last marker not used.
 * @property {number} kind
 *   How many markers are left modulo 3, times 2, plus whether it can close,
 *   or, for other markers, its size.
 * @property {number} large
 *   Its size.
 * @property {number} least
 *   Smallest kind of runs that do not skip it.
 * @property {List | undefined} list
 *   Sequences involved with `wrong`.
 * @property {Array<List | undefined>} lists
 *   Sequences involved with each sequence, if wrong.
 * @property {number} most
 *   Largest kind of runs that do not skip it.
 * @property {Map<number, Map<number, Entry>>} nodes
 *   Nodes with it, by their halves.
 * @property {number} rank
 *   Priority of it, from `token`.
 * @property {Array<number>} sizes
 *   Markers of each sequence.
 * @property {number} small
 *   Its size.
 * @property {number} start
 *   Index of the first marker not used.
 * @property {number} token
 *   First sequence.
 * @property {number} undone
 *   Sequence of the first marker not used.
 * @property {number} wrong
 *   First sequence that does not (yet) form its attention, or `Infinity`.
 */

/**
 * @typedef {Entry | null} Snapshot
 *   State of pairing at a token: the runs that can open, or `null`.
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
 * @property {List | undefined} list
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
 * @typedef Version
 *   What is known of pairing a marker, after a try.
 * @property {[number, List | undefined]} end
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
 * @param {List} involved
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
  for (const sequence of items(involved)) {
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
 * @returns {[number, List] | undefined}
 *   First sequence that does not form its attention, and the sequences
 *   involved, if any.
 */
function check(serialization) {
  const {markers, values, versions} = serialization
  const length = values.length
  const pairings = versions.map(({known, tree}) =>
    restore(
      known,
      // Nothing is open at the start, and everything is decided at the end.
      known && known < length
        ? /** @type {Snapshot} */ (read(serialization, tree, known))
        : null
    )
  )
  let [first, list] = [Infinity, /** @type {List | undefined} */ (undefined)]

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
      const bound = Math.min(pairing.index, undone(serialization, pairing))

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
 * @param {List} involved
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
  // Builtin sequences pair one or two markers at a time,
  // so longer ones never form.
  serialization.worse =
    builtins.has(values[mistake].charAt(0)) && values[mistake].length > 2
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

      let pairing = restore(index, state || null)

      while (!serialization.worse) {
        advance(serialization, lane, pairing)
        index = pairing.index

        if (index > settled && wrongAt(pairing.state, mistake)) {
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

        // At the end, pairing stops anyway.
        if (index < length && (after || changed[next] > index)) {
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
        const done = index > mistake && undone(serialization, pairing) > mistake

        if (
          index === length ||
          (done &&
            (index >= version.known ||
              (after && serialization.found < undone(serialization, pairing))))
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
  // Builtins can split runs.
  const split = builtins.has(serialization.markers[lane])
  let low = Infinity
  /** @type {Run | undefined} */
  let opener
  // Whether a done sequence of the closer has a list.
  let kept = false

  while (closer.close && closer.start < closer.end) {
    const closerSize = closer.end - closer.start
    const left = closerSize % 3
    const skip = (3 - left) * 2
    // The last run that pairs:
    // following the rule of 3, on the sizes that are left,
    // runs of `3 - left` left skip it if they can close or it can open;
    // others pair whole runs of the same size.
    const smallest = split
      ? left
        ? skip + (closer.open ? 0 : 1)
        : Infinity
      : closerSize
    const largest = split ? (left ? skip + 1 : -Infinity) : closerSize

    // The run that paired is written once it is done:
    // runs after it are as they were, so while none of them pair,
    // it is the last one that pairs if it still does.
    if (
      !opener ||
      opener.start === opener.end ||
      !fits(kindOf(split, opener), smallest, largest, split) ||
      last(pairing.state, smallest, largest, split, opener.tokens[0] + 1)
    ) {
      if (opener) save(serialization, lane, pairing, opener)
      const data = last(pairing.state, smallest, largest, split, -Infinity)
      opener = data && unpack(data)
      if (!opener) break
    }

    const token = opener.tokens[0]
    const openerSize = opener.end - opener.start
    low = Math.min(low, token)
    const size = split ? (openerSize > 1 && closerSize > 1 ? 2 : 1) : closerSize
    const openAt = sequence(opener, opener.end - size)
    const closeAt = sequence(closer, closer.start)
    const opened = sequence(opener, opener.end - 1)
    const closed = sequence(closer, closer.start + size - 1)
    /** @type {Array<number>} */
    const involved = []
    for (let at = openAt; at <= opened; at++) involved.push(at)
    for (let at = closeAt; at <= closed; at++) involved.push(at)

    // Whole sequences:
    // the markers of a sequence are next to each other,
    // so if the first and last marker are of one sequence of that size,
    // all markers are exactly that sequence.
    const whole =
      openAt === opened &&
      values[openAt].length === size &&
      closeAt === closed &&
      values[closeAt].length === size &&
      // Of the same attention, so its opening and closing sequence.
      attentions[openAt] === attentions[closeAt]
    /** @type {Map<List, List>} */
    const added = new Map()
    opener.end -= size
    closer.start += size

    for (const at of involved) {
      const run = at < closeAt ? opener : closer
      const index = at - run.tokens[0]
      const list = run.lists[index]
      // A sequence is done once all its markers are used.
      const done = !(
        run.start < run.end &&
        sequence(run, run.start) <= at &&
        at <= sequence(run, run.end - 1)
      )
      // Lists of sequences that are done are used if they are decided first,
      // and the first in a run that stays open.
      // Done sequences of openers come after ones that are not;
      // closers that can open stay open with the first done here.
      const lazy = done && !(run === closer && closer.open && !kept)

      if (whole) {
        run.lists[index] = undefined
      } else if (!lazy) {
        // Add to what is involved already:
        // a sequence can be in several pairs.
        // Lists are shared, so this makes a new one.
        // Sequences that formed have no markers left, so these are all wrong.
        let result = added.get(/** @type {List} */ (list))

        // Sequences often share lists.
        if (!result) {
          result = /** @type {List} */ (extend(serialization, list, involved))
          added.set(/** @type {List} */ (list), result)
        }

        run.lists[index] = result
        if (done && run === closer) kept = true
      }

      if (done) {
        decide(
          serialization,
          pairing,
          at,
          run.lists[index],
          lazy && !whole ? involved : undefined
        )
      }
    }

    // Search again from the start, as this run may close more.
  }

  if (opener) save(serialization, lane, pairing, opener)

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
 * Write a run that paired to the state of pairing.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} lane
 *   Marker.
 * @param {Pairing} pairing
 *   State of pairing, changed.
 * @param {Run} run
 *   Run.
 * @returns {undefined}
 *   Nothing.
 */
function save(serialization, lane, pairing, run) {
  pairing.state = change(
    serialization,
    pairing.state,
    run.tokens[0],
    run.start === run.end ? undefined : describe(serialization, lane, run)
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
    changes: [],
    count: 0,
    found: Infinity,
    hollow: false,
    lists: new Map(),
    log: undefined,
    markers: [],
    memos: [],
    mistake: -1,
    queue: [],
    runs: new Map(),
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
    const {state} = pairing
    const end = step(serialization, lane, pairing, pairing.index)

    if (trying) {
      leaves.push(
        leaf(
          state,
          pairing.low,
          pairing.kind,
          pairing.decided,
          pairing.involved
        )
      )
      while (pairing.start + leaves.length < end) leaves.push(empty)
    }

    pairing.index = end
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

  // At the end, what is still open does not form,
  // of which the first sequence is what counts.
  if (pairing.index === values.length) {
    pairing.decided = Infinity
    const {state} = pairing
    if (state) decide(serialization, pairing, state.wrong, state.list)
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
 * @param {List | undefined} list
 *   Sequences involved, if wrong.
 * @param {Array<number> | undefined} [extra]
 *   Sequences to add to `list`, if any.
 * @returns {undefined}
 *   Nothing.
 */
function decide(serialization, pairing, at, list, extra) {
  if (!list) return
  if (at <= serialization.mistake) serialization.worse = true
  else serialization.found = Math.min(serialization.found, at)

  if (at < pairing.first) {
    pairing.first = at
    pairing.list = list
    pairing.listAdded = extra
  }

  if (at < pairing.decided) {
    pairing.decided = at
    pairing.involved = list
    pairing.involvedAdded = extra
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
  let cut = Infinity

  for (const other of seen) {
    if (other.state === here) {
      use = other
      cut = Infinity
      to = Infinity
      break
    }

    // Runs that differ pair with nothing until a later run pairs
    // with one of them before,
    // or looks at all of them while it does not skip each of them,
    // following the rule of 3 in `pair`,
    // or, for other markers, while it is of the size of one of them:
    // until then, pair as in the version, with those runs as they are.
    const from = differ(serialization, other.state, here) + 1
    const {large, least, most, small} = before(here, from)
    // Kinds that are fine, or, for other markers, sizes that are not.
    const low = split ? least : small
    const high = split ? most : large

    const {known, tree} = other.version
    const far = Math.min(
      reach(serialization, lane, tree, index, from, low, high),
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
      locate(serialization, tree, end)[0] === undefined
    ) {
      end--
    }

    if (end <= to) continue
    to = end
    use = other
    cut = from
  }

  return use
    ? [
        use,
        to,
        cut === Infinity
          ? undefined
          : {
              add: divide(serialization, here, cut)[0],
              cut,
              floor: -Infinity,
              under: undefined
            }
      ]
    : undefined
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

  return restore(
    end,
    end === length
      ? null
      : /** @type {Snapshot} */ (read(serialization, version.tree, end))
  )
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
 * the first sequence of the runs that are open there that does not.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Tree} tree
 *   Tree of a version.
 * @returns {[number, List | undefined]}
 *   Sequence, or `Infinity`, and the sequences involved.
 */
function ending(serialization, tree) {
  const state = read(serialization, tree, serialization.values.length)
  return state ? [state.wrong, state.list] : [Infinity, undefined]
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
 * @param {List | undefined} list
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
 * Patch a snapshot.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Snapshot} state
 *   Snapshot.
 * @param {Patch} patch
 *   Patch.
 * @returns {Snapshot}
 *   Snapshot.
 */
function apply(serialization, state, patch) {
  /** @type {Array<Patch>} */
  const layers = []
  /** @type {Snapshot} */
  let result = null

  for (
    let layer = /** @type {Patch | undefined} */ (patch);
    layer;
    layer = layer.under
  ) {
    layers.push(layer)
  }

  let index = layers.length

  // Layers further down add runs before those of layers above.
  while (index--) {
    const {add, floor} = layers[index]
    result = merge(serialization, result, divide(serialization, add, floor)[1])
  }

  return merge(
    serialization,
    result,
    divide(serialization, state, patch.cut)[1]
  )
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
  if (!patch.add || patch.add.last < floor) return bottom
  return {
    ...patch,
    floor,
    under: patch.under ? trim(patch.under, cut, bottom) : bottom
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
  return patch && state !== undefined
    ? apply(serialization, state, patch)
    : state
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
 * Get the state of pairing at a snapshot.
 *
 * @param {number} index
 *   Token of the snapshot.
 * @param {Snapshot} state
 *   Snapshot.
 * @returns {Pairing}
 *   State of pairing.
 */
function restore(index, state) {
  return {
    decided: Infinity,
    first: Infinity,
    index,
    involved: undefined,
    involvedAdded: undefined,
    kind: undefined,
    leaves: [],
    list: undefined,
    listAdded: undefined,
    low: Infinity,
    start: index,
    state
  }
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
 * Get the state of a run that can open,
 * the same for runs in the same state.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} lane
 *   Marker.
 * @param {Run} run
 *   Run.
 * @returns {Data}
 *   State.
 */
function describe(serialization, lane, run) {
  const {runs} = serialization
  const {close, end, lists, sizes, start, tokens} = run
  // Lists of sequences that are done are used only if they are first.
  const index = lists.findIndex(Boolean)
  const from = sequence(run, start) - tokens[0]
  const to = sequence(run, end - 1) - tokens[0]
  const key = [
    lane,
    tokens[0],
    start,
    end,
    Number(close),
    sizes.join(' '),
    ...lists.map((list, at) =>
      list ? (at === index || (from <= at && at <= to) ? list.id : -1) : 0
    )
  ].join(',')
  let data = runs.get(key)

  if (!data) {
    const size = end - start
    // Runs that can open have markers left, so a sequence that is wrong.
    const rest = size % 3
    // Skipped by runs with `3 - rest` left that can open,
    // or that cannot if it can close, as in `pair`.
    const kind = (3 - rest) * 2
    data = {
      close,
      end,
      kind: kindOf(builtins.has(serialization.markers[lane]), run),
      large: size,
      least: rest ? (close ? kind : kind + 1) : Infinity,
      list: lists[index],
      lists,
      most: rest ? kind + 1 : Infinity,
      nodes: new Map(),
      rank: rank(tokens[0]),
      sizes,
      small: size,
      start,
      token: tokens[0],
      undone: sequence(run, start),
      wrong: tokens[index]
    }
    runs.set(key, data)
  }

  return data
}

/**
 * Get the map at a key of a map, made if needed.
 *
 * @template T
 *   Value.
 * @param {Map<number, Map<number, T>>} map
 *   Map.
 * @param {number} key
 *   Key.
 * @returns {Map<number, T>}
 *   Map.
 */
function nested(map, key) {
  let value = map.get(key)

  if (!value) {
    value = new Map()
    map.set(key, value)
  }

  return value
}

/**
 * Get a node of a list, the same for the same sequence and halves.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} at
 *   Sequence.
 * @param {List | undefined} left
 *   Sequences before.
 * @param {List | undefined} right
 *   Sequences after.
 * @returns {List}
 *   List.
 */
function node(serialization, at, left, right) {
  const nodes = nested(serialization.lists, at)

  const halves = nested(nodes, left ? left.id : 0)
  const key = right ? right.id : 0
  let list = halves.get(key)

  if (!list) {
    list = {
      at,
      id: ++serialization.count,
      left,
      rank: rank(at),
      right
    }
    halves.set(key, list)
  }

  return list
}

/**
 * Add sequences to a list.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {List | undefined} list
 *   List.
 * @param {Array<number> | undefined} extra
 *   Sequences, if any.
 * @returns {List | undefined}
 *   List.
 */
function extend(serialization, list, extra) {
  for (const at of extra || []) {
    if (!includes(list, at)) list = insert(serialization, list, at, rank(at))
  }

  return list
}

/**
 * Make the list of sequences from one up to another.
 *
 * Sequences come in order,
 * so this keeps the nodes on the right edge whose right halves are not done.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} start
 *   First sequence.
 * @param {number} end
 *   Sequence after the last.
 * @returns {List | undefined}
 *   List.
 */
function range(serialization, start, end) {
  /** @type {Array<[number, List | undefined]>} */
  const edge = []

  // The last one, past the sequences, is above all nodes.
  for (let at = start; at <= end; at++) {
    const priority = at < end ? rank(at) : Infinity
    /** @type {List | undefined} */
    let list

    while (edge.length > 0 && rank(edge[edge.length - 1][0]) < priority) {
      const [above, left] = /** @type {[number, List | undefined]} */ (
        edge.pop()
      )
      list = node(serialization, above, left, list)
    }

    edge.push([at, list])
  }

  return edge[0][1]
}

/**
 * Add a sequence to a list that does not have it.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {List | undefined} list
 *   List.
 * @param {number} at
 *   Sequence.
 * @param {number} priority
 *   Its priority.
 * @returns {List}
 *   List.
 */
function insert(serialization, list, at, priority) {
  if (!list) return node(serialization, at, undefined, undefined)

  if (priority > list.rank) {
    const [left, right] = halve(serialization, list, at)
    return node(serialization, at, left, right)
  }

  return at < list.at
    ? node(
        serialization,
        list.at,
        insert(serialization, list.left, at, priority),
        list.right
      )
    : node(
        serialization,
        list.at,
        list.left,
        insert(serialization, list.right, at, priority)
      )
}

/**
 * Split a list that does not have a sequence at it.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {List | undefined} list
 *   List.
 * @param {number} at
 *   Sequence.
 * @returns {[List | undefined, List | undefined]}
 *   Sequences before it, and after it.
 */
function halve(serialization, list, at) {
  if (!list) return [undefined, undefined]

  if (list.at < at) {
    const [left, right] = halve(serialization, list.right, at)
    return [node(serialization, list.at, list.left, left), right]
  }

  const [left, right] = halve(serialization, list.left, at)
  return [left, node(serialization, list.at, right, list.right)]
}

/**
 * Get the sequences of a list, in order.
 *
 * @param {List | undefined} list
 *   List.
 * @param {Array<number>} [result]
 *   Sequences so far, changed.
 * @returns {Array<number>}
 *   Sequences.
 */
function items(list, result = []) {
  if (list) {
    items(list.left, result)
    result.push(list.at)
    items(list.right, result)
  }

  return result
}

/**
 * Check whether a list has a sequence.
 *
 * @param {List | undefined} list
 *   List.
 * @param {number} at
 *   Sequence.
 * @returns {boolean}
 *   Whether it does.
 */
function includes(list, at) {
  while (list && list.at !== at) {
    list = at < list.at ? list.left : list.right
  }

  return Boolean(list)
}

/**
 * Get the run of a state of a run that can open.
 *
 * @param {Data} data
 *   State.
 * @returns {Run}
 *   Run.
 */
function unpack(data) {
  const {close, end, lists, sizes, start, token} = data
  /** @type {Array<number>} */
  const ends = []
  let total = 0
  for (const size of sizes) ends.push((total += size))
  // Runs that can open, `pair` checks this on closers only.
  return {
    close,
    end,
    ends,
    lists: [...lists],
    open: true,
    sizes,
    start,
    tokens: sizes.map((_, index) => token + index)
  }
}

/**
 * Get the sequence of a marker of a run.
 *
 * @param {Run} run
 *   Run.
 * @param {number} marker
 *   Index of the marker.
 * @returns {number}
 *   Token.
 */
function sequence(run, marker) {
  const {ends} = run
  let low = 0
  let high = ends.length - 1

  // The first sequence that ends after the marker.
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (ends[middle] > marker) high = middle
    else low = middle + 1
  }

  return run.tokens[low]
}

/**
 * Get a node of a snapshot, the same for the same run and halves.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Data} data
 *   Run.
 * @param {Snapshot} left
 *   Runs before.
 * @param {Snapshot} right
 *   Runs after.
 * @returns {Entry}
 *   Node.
 */
function entry(serialization, data, left, right) {
  const halves = nested(data.nodes, left ? left.id : 0)
  const key = right ? right.id : 0
  let node = halves.get(key)

  if (!node) {
    const below = left || none
    const after = right || none
    const first = below.wrong < Infinity ? below : data
    node = {
      bottom: Math.min(below.bottom, data.kind, after.bottom),
      data,
      first: left ? left.first : data.token,
      id: ++serialization.count,
      large: Math.max(below.large, data.large, after.large),
      last: right ? right.last : data.token,
      least: Math.max(below.least, data.least, after.least),
      left,
      list: first.list,
      most: Math.min(below.most, data.most, after.most),
      right,
      small: Math.min(below.small, data.small, after.small),
      top: Math.max(below.top, data.kind, after.top),
      undone: left ? left.undone : data.undone,
      wrong: first.wrong
    }
    halves.set(key, node)
  }

  return node
}

/**
 * Get the priority of a sequence in trees.
 *
 * @param {number} token
 *   Sequence.
 * @returns {number}
 *   Priority.
 */
function rank(token) {
  // Cubes modulo this prime are all different, and the products stay exact.
  // Tokens past it come after, so all priorities are different.
  const prime = 67_108_859
  const base = Math.floor(token / prime) * prime
  const at = (token + 12_345) % prime
  const square = (at * at) % prime
  const cube = (square * at) % prime
  const scaled = 40_503 * cube
  const value = (scaled + 31_337) % prime
  return base + value
}

/**
 * Split a snapshot at a sequence.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Snapshot} node
 *   Snapshot.
 * @param {number} cut
 *   Sequence.
 * @returns {[Snapshot, Snapshot]}
 *   Runs before it, and runs from it.
 */
function divide(serialization, node, cut) {
  if (!node) return [null, null]
  // Often, all runs are on one side.
  if (node.last < cut) return [node, null]
  if (node.first >= cut) return [null, node]

  if (node.data.token < cut) {
    const [low, high] = divide(serialization, node.right, cut)
    return [entry(serialization, node.data, node.left, low), high]
  }

  const [low, high] = divide(serialization, node.left, cut)
  return [low, entry(serialization, node.data, high, node.right)]
}

/**
 * Merge snapshots, where all runs of one are before those of the other.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Snapshot} low
 *   Runs before.
 * @param {Snapshot} high
 *   Runs after.
 * @returns {Snapshot}
 *   Snapshot.
 */
function merge(serialization, low, high) {
  if (!low) return high
  if (!high) return low
  return low.data.rank > high.data.rank
    ? entry(
        serialization,
        low.data,
        low.left,
        merge(serialization, low.right, high)
      )
    : entry(
        serialization,
        high.data,
        merge(serialization, low, high.left),
        high.right
      )
}

/**
 * Set or remove the run at a sequence in a snapshot.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Snapshot} node
 *   Snapshot.
 * @param {number} token
 *   First sequence of the run.
 * @param {Data | undefined} data
 *   Run, if any, which is new if the snapshot does not have it.
 * @returns {Snapshot}
 *   Snapshot.
 */
function change(serialization, node, token, data) {
  if (node && node.data.token === token) {
    return data
      ? entry(serialization, data, node.left, node.right)
      : merge(serialization, node.left, node.right)
  }

  // A new run that goes above the runs of the node.
  if (!node || (data && data.rank > node.data.rank)) {
    const [low, high] = divide(serialization, node, token)
    return entry(serialization, /** @type {Data} */ (data), low, high)
  }

  return token < node.data.token
    ? entry(
        serialization,
        node.data,
        change(serialization, node.left, token, data),
        node.right
      )
    : entry(
        serialization,
        node.data,
        node.left,
        change(serialization, node.right, token, data)
      )
}

/**
 * Check whether a run of a kind pairs.
 *
 * @param {number} kind
 *   Kind.
 * @param {number} low
 *   Smallest kind.
 * @param {number} high
 *   Largest kind.
 * @param {boolean} outside
 *   Whether runs not of those kinds pair instead.
 * @returns {boolean}
 *   Whether it pairs.
 */
function fits(kind, low, high, outside) {
  return (low <= kind && kind <= high) !== outside
}

/**
 * Get the kind of a run that can open.
 *
 * @param {boolean} split
 *   Whether runs can split.
 * @param {Run} run
 *   Run.
 * @returns {number}
 *   Kind.
 */
function kindOf(split, run) {
  const size = run.end - run.start
  const double = (size % 3) * 2
  return split ? double + Number(run.close) : size
}

/**
 * Find the last run of a kind.
 *
 * @param {Snapshot} node
 *   Snapshot.
 * @param {number} low
 *   Smallest kind.
 * @param {number} high
 *   Largest kind.
 * @param {boolean} outside
 *   Whether to find a run not of those kinds instead.
 * @param {number} from
 *   First sequence of runs to look at.
 * @returns {Data | undefined}
 *   Run, if any.
 */
function last(node, low, high, outside, from) {
  if (
    !node ||
    node.last < from ||
    (outside
      ? low <= node.bottom && node.top <= high
      : node.top < low || high < node.bottom)
  ) {
    return undefined
  }

  const {data} = node
  return (
    last(node.right, low, high, outside, from) ||
    (data.token >= from && fits(data.kind, low, high, outside)
      ? data
      : undefined) ||
    last(node.left, low, high, outside, from)
  )
}

/**
 * Get what the runs of a snapshot before a sequence aggregate to.
 *
 * @param {Snapshot} node
 *   Snapshot.
 * @param {number} cut
 *   Sequence.
 * @returns {{large: number, least: number, most: number, small: number}}
 *   Aggregates.
 */
function before(node, cut) {
  const result = {...none}

  while (node) {
    if (node.data.token < cut) {
      for (const value of [node.left || none, node.data]) {
        result.large = Math.max(result.large, value.large)
        result.least = Math.max(result.least, value.least)
        result.most = Math.min(result.most, value.most)
        result.small = Math.min(result.small, value.small)
      }

      node = node.right
    } else {
      node = node.left
    }
  }

  return result
}

/**
 * Check whether a sequence of a snapshot does not (yet) form its attention.
 *
 * @param {Snapshot} node
 *   Snapshot.
 * @param {number} at
 *   Sequence.
 * @returns {boolean}
 *   Whether it does not.
 */
function wrongAt(node, at) {
  /** @type {Data | undefined} */
  let run

  while (node) {
    if (node.data.token > at) {
      node = node.left
    } else {
      run = node.data
      node = node.right
    }
  }

  return run ? run.lists[at - run.token] !== undefined : false
}

/**
 * Get the last sequence where two snapshots differ.
 *
 * Nodes are shared, so this takes the time of a few splits.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Snapshot} a
 *   Snapshot.
 * @param {Snapshot} b
 *   Other snapshot.
 * @returns {number}
 *   First sequence of the last run that differs, or `-Infinity`.
 */
function differ(serialization, a, b) {
  if (a === b) return -Infinity
  if (!a || !b) return /** @type {Entry} */ (a || b).last

  if (a.data.token === b.data.token) {
    const right = differ(serialization, a.right, b.right)
    if (right !== -Infinity) return right
    return a.data === b.data
      ? differ(serialization, a.left, b.left)
      : a.data.token
  }

  // The run of the node that goes above is not in the other snapshot.
  const [high, low] = a.data.rank > b.data.rank ? [a, b] : [b, a]
  return Math.max(
    high.data.token,
    differ(
      serialization,
      high.right,
      divide(serialization, low, high.data.token)[1]
    )
  )
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
    ends: [],
    lists: [],
    sizes: [],
    start: 0,
    end: 0,
    // Underscores are strict, they cannot open or close inside words.
    open: strict ? open && (Boolean(previous) || !close) : open,
    close: strict ? close && (Boolean(next) || !open) : close
  }

  const list = range(serialization, index, end)

  for (let at = index; at < end; at++) {
    run.tokens.push(at)
    // Every sequence is wrong until it pairs with its other sequence.
    run.lists.push(list)
    run.sizes.push(values[at].length)
    run.end += values[at].length
    run.ends.push(run.end)
  }

  pair(serialization, lane, pairing, run)

  if (run.open && run.start < run.end) {
    pairing.state = change(
      serialization,
      pairing.state,
      index,
      describe(serialization, lane, run)
    )
  } else {
    for (const [offset, at] of run.tokens.entries()) {
      decide(serialization, pairing, at, run.lists[offset])
    }
  }

  // Lists of sequences done while pairing are made once they are used.
  pairing.list = extend(serialization, pairing.list, pairing.listAdded)
  pairing.involved = extend(
    serialization,
    pairing.involved,
    pairing.involvedAdded
  )
  pairing.listAdded = undefined
  pairing.involvedAdded = undefined
  return end
}

/**
 * Get the first sequence that is not done pairing:
 * the sequence of the first marker that is not used of the first run that
 * can still open.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Pairing} pairing
 *   State of pairing.
 * @returns {number}
 *   Token, or `Infinity`.
 */
function undone(serialization, pairing) {
  // At the end, everything is done.
  return pairing.state && pairing.index < serialization.values.length
    ? pairing.state.undone
    : Infinity
}

/**
 * Get the first sequence that a version decides does not form its attention.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Version} version
 *   Version.
 * @returns {[number, List | undefined]}
 *   Sequence, or `Infinity`, and the sequences involved.
 */
function wrongs(serialization, version) {
  const {known} = version
  /** @type {[number, List | undefined]} */
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
