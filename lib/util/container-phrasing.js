/**
 * @import {Attention, Handle, Info, State, Tracker} from 'mdast-util-to-markdown'
 * @import {PhrasingParents, TrackFields} from '../types.js'
 */

import {asciiPunctuation} from 'micromark-util-character'
import {classifyCharacter} from 'micromark-util-classify-character'
import {firstCharacter, lastCharacter} from './character.js'
import {encodeCharacterReference} from './encode-character-reference.js'
import {encodeInfo} from './encode-info.js'
import {htmlKind} from './html-kind.js'

// Larger than any token, sequence, size, kind, or rank.
// As a small integer (`2 ** 30 - 1`), fields that hold it are not boxed.
const infinity = 1_073_741_823

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
 * Tree of nothing:
 * of tokens that pairing did not reach, or in the middle of a run.
 *
 * @type {Tree}
 */
const empty = {
  kinds: 0,
  left: undefined,
  list: undefined,
  low: infinity,
  patch: undefined,
  right: undefined,
  state: undefined,
  wrong: infinity
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
 *   Value of a string before its parent encodes it, or sequence of attention.
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
 *   Value of a string after encoding its start for attention before it,
 *   or sequence of attention.
 */

/**
 * What runs aggregate to without runs.
 */
const none = {
  kinds: 0,
  list: undefined,
  skips: 63,
  wrong: infinity
}

/**
 * @typedef Pairing
 *   State of pairing runs of a marker like `micromark`.
 * @property {number} decided
 *   First sequence that the last run decided does not form its attention,
 *   or, at the end, of the runs open there.
 * @property {number} first
 *   First sequence decided that does not form its attention.
 * @property {number} index
 *   Token where pairing is.
 * @property {List | undefined} involved
 *   Sequences involved with `decided`, while trying.
 * @property {Array<number> | undefined} involvedAdded
 *   Sequences to add to `involved` once the run is done, while trying.
 * @property {number | undefined} kind
 *   Kind of the last run, if it looked at all runs that can open.
 * @property {Array<Tree>} leaves
 *   What pairing keeps at each token from `start`.
 * @property {List | undefined} list
 *   Sequences involved with `first`, in checks.
 * @property {Array<number> | undefined} listAdded
 *   Sequences to add to `list` once the run is done, in checks.
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
 * @property {Map<number, Array<number>>} added
 *   Sequences to add to `lists`, by index, once they are used.
 * @property {Array<number>} ends
 *   Markers up to the end of each sequence.
 * @property {Array<List | undefined>} lists
 *   Sequences involved with each sequence, if it does not (yet) form its
 *   attention;
 *   for sequences that are done, only whether there are any,
 *   except for the first that a closer which can open is done with.
 * @property {boolean} open
 *   Whether it can open.
 * @property {Array<number>} sizes
 *   Markers of each sequence.
 * @property {number} start
 *   Index of the first marker not used (to close).
 * @property {number} token
 *   First sequence.
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
 *   First sequence after the mistake that a try decided does not form its
 *   attention, for the marker it pairs, of the runs it paired itself.
 * @property {number} count
 *   Count of nodes of snapshots and lists.
 * @property {Map<number, Map<number, Map<number, List>>>} lists
 *   Nodes of lists of sequences, by their sequence and halves.
 * @property {boolean} choices
 *   Whether there is attention that can use another sequence.
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
 *   snapshots of versions at tokens where checks paired while trying,
 *   and where tries paired after what they changed,
 *   from which pairing goes as in that version while the tokens after are as
 *   they were.
 * @property {number} mistake
 *   Mistake while trying, or `-1`.
 * @property {number} memosFrom
 *   Token from which memos are kept.
 * @property {Array<Node>} queue
 *   Nodes to render again.
 * @property {Map<number, Map<string, Data>>} runs
 *   States of runs that can open, by their first sequence and what they are.
 * @property {number} runsFrom
 *   Sequence from which runs and lists are kept.
 * @property {number} size
 *   Leaves of trees: once planted, a power of two above the count of tokens.
 * @property {Array<number>} strings
 *   Tokens of strings outside attention.
 * @property {number} string
 *   Index in `strings` of the first string not before the mistake.
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
 * @property {Data} data
 *   Run.
 * @property {number} first
 *   First sequence of its first run.
 * @property {number} id
 *   Number of it.
 * @property {number} kinds
 *   Kinds of its runs, as bits.
 * @property {number} last
 *   First sequence of its last run.
 * @property {Snapshot} left
 *   Runs before.
 * @property {List | undefined} list
 *   Sequences involved with `wrong`.
 * @property {Snapshot} right
 *   Runs after.
 * @property {number} skips
 *   Kinds of runs that skip all its runs, as bits.
 * @property {number} undone
 *   Sequence of the first marker not used of its first run.
 * @property {number} wrong
 *   First sequence of its runs that does not (yet) form its attention.
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
 * @property {List | undefined} list
 *   Sequences involved with `wrong`.
 * @property {Array<List | undefined>} lists
 *   Sequences involved with each sequence, if wrong;
 *   for sequences that are done, only whether there are any, unless first.
 * @property {Map<number, Map<number, Entry>>} nodes
 *   Nodes with it, by their halves.
 * @property {number} rank
 *   Priority of it, from `token`.
 * @property {Array<number>} sizes
 *   Markers of each sequence.
 * @property {number} skips
 *   Kinds of runs that skip it, as bits.
 * @property {number} start
 *   Index of the first marker not used.
 * @property {number} token
 *   First sequence.
 * @property {number} undone
 *   Sequence of the first marker not used.
 * @property {number} wrong
 *   First sequence that does not (yet) form its attention.
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
 *   each node has the smallest value (or all bits) of its two children,
 *   leaves are tokens.
 *   Versions share nodes, which do not change.
 *   To keep them small, leaves have no halves,
 *   and other nodes no snapshot and no patch until patched;
 *   `empty` has all fields.
 * @property {number} kinds
 *   Kinds of the runs that look at all runs that can open, as bits,
 *   where the kind is how many markers are left modulo 3,
 *   times 2, plus whether it can open,
 *   or, for other markers, its size.
 * @property {Tree | undefined} [left]
 *   First half.
 * @property {List | undefined} list
 *   Sequences involved with `wrong`.
 * @property {number} low
 *   First sequence of the lowest run that a run pairs with to close,
 *   or `infinity`.
 * @property {Patch | undefined} [patch]
 *   Change to the snapshots of the leaves.
 * @property {Tree | undefined} [right]
 *   Second half.
 * @property {Snapshot | undefined} [state]
 *   Snapshot before the token, of a leaf, if not in the middle of a run.
 * @property {number} wrong
 *   First sequence that a run decides does not form its attention,
 *   or `infinity`.
 */

/**
 * @typedef Version
 *   What is known of pairing a marker, after a try.
 * @property {[number, List | undefined]} end
 *   First sequence that does not form of the runs open at the end,
 *   and the sequences involved, if pairing is known up to the end.
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
      const end = runEnd(serialization, at)
      let start = at
      while (start > 0 && isMarker(serialization, start - 1, marker)) start--

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
 * and, while trying, keeps the state of pairing at each token,
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
  let first = infinity
  /** @type {List | undefined} */
  let list

  for (const version of versions) {
    const [at, involved] = wrongs(serialization, version)
    if (at >= first) continue
    first = at
    list = involved
  }

  while (true) {
    // Sequences before `frontier` are done pairing, for every marker.
    let frontier = length
    let behind = -1
    let lane = -1

    while (++lane < markers.length) {
      const pairing = pairings[lane]
      if (pairing.first < first) {
        first = pairing.first
        list = pairing.list
      }

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
      infinity
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
    if (at >= first) continue
    first = at
    list = involved
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
  return serialize(phrasing(parent, state, info)[0], info.before, info.after)
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
 * and for each marker, runs are paired again from before the first change,
 * from the state of pairing there,
 * moving past tokens that pair as in a version up to the next change,
 * until the state of pairing is as in a version,
 * except for runs that version does not look at for a while,
 * or until sequences up to the mistake are done pairing,
 * past where pairing is known or where the next mistake is known,
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

  // The opening sequence of the attention is always one of them.
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
    made.push(version)
    serialization.found = infinity

    // Pairing is known only before the first change, where it is as before;
    // checks pair the rest.
    if (changed[0] > version.known) continue

    let next = 0
    // Start before the token before the change,
    // as the run with that token can open or close depending on it.
    let pairing = resume(
      serialization,
      version.tree,
      Math.max(changed[0] - 1, 0)
    )

    while (!serialization.worse) {
      advance(serialization, lane, pairing)
      let index = pairing.index

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
          index <= old.known ? read(serialization, old.tree, index) : undefined
        /** @type {Array<Seen>} */
        const seen =
          current === undefined ? [] : [{state: current, version: old}]
        if (after) seen.push(...valid(serialization, lane, index, old))
        const found = choose(
          serialization,
          lane,
          pairing,
          seen,
          after ? infinity : changed[next] - 1
        )

        if (found) {
          const [use, to] = found
          // Where the rest pairs as in the old version,
          // its leaf here is kept too, and what it knows.
          const rest = to === infinity && use.version === old
          flush(serialization, version, pairing, rest)

          if (rest) {
            // Its tree after here is still that of the old version,
            // which knows this token.
            adopt(version, old)
            break
          }

          pairing = move(serialization, version, pairing, found)
          if (to !== infinity && pairing.index < length) continue
        }
      }

      // Stop once sequences up to the mistake are done pairing,
      // where pairing is not known,
      // or, past all changes, where the next mistake is known:
      // pairing on to there saves checks pairing the changes again.
      index = pairing.index
      const done = index > mistake && undone(serialization, pairing) > mistake

      if (
        index === length ||
        (done &&
          (index >= version.known ||
            (after && serialization.found < undone(serialization, pairing))))
      ) {
        version.known = index
        break
      }
    }

    // Pairing is known up to where it stopped.
    if (serialization.worse) version.known = pairing.index

    flush(serialization, version, pairing)
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
  let low = infinity
  /** @type {Run | undefined} */
  let opener
  // Whether a done sequence of the closer has a list.
  let kept = false

  while (closer.close && closer.start < closer.end) {
    const closerSize = closer.end - closer.start
    // The last run that pairs: one that does not skip it by the rule of 3,
    // on the sizes that are left, or, for other markers, of the same size.
    const kinds = split
      ? 63 - skipped(closer.open, closerSize % 3)
      : bit(closerSize)
    const exact = split ? -1 : closerSize

    // The run that paired is written once it is done:
    // runs after it are as they were, so while none of them pair,
    // it is the last one that pairs if it still does.
    if (
      !opener ||
      opener.start === opener.end ||
      !fits(kindOf(split, opener), kinds, exact) ||
      last(pairing.state, kinds, exact, opener.token + 1)
    ) {
      if (opener) save(serialization, lane, pairing, opener)
      const data = last(pairing.state, kinds, exact, -infinity)
      opener = data && unpack(data)
      if (!opener) break
    }

    const token = opener.token
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
    opener.end -= size
    closer.start += size

    for (const at of involved) {
      const run = at < closeAt ? opener : closer
      const index = at - run.token
      // Add to what is involved already: a sequence can be in several pairs.
      // Sequences that formed have no markers left, so these are all wrong.
      const extra = run.added.get(index) || []
      extra.push(...involved)
      // A sequence is done once all its markers are used.
      const done = !(
        run.start < run.end &&
        sequence(run, run.start) <= at &&
        at <= sequence(run, run.end - 1)
      )
      // Lists are made once they are used:
      // for sequences that are done, if they are decided first,
      // or the first in a run that stays open;
      // done sequences of openers come after ones that are not,
      // closers that can open keep it for the first done here,
      // in case they stay open.
      run.added.delete(index)

      if (whole) {
        run.lists[index] = undefined
      } else if (!done) {
        run.added.set(index, extra)
      } else if (run === closer && closer.open && !kept) {
        run.lists[index] = extend(serialization, run.lists[index], extra)
        kept = true
        decide(serialization, pairing, at, run.lists[index])
      } else {
        decide(serialization, pairing, at, run.lists[index], extra)
      }
    }

    // Look again for the last run that pairs, as this run may close more.
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
    run.token,
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
 * @returns {[Array<Item>, Tracker]}
 *   Items, and tracker after them.
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
  /**
   * Where the last item starts, if it is a string that ends in an eol.
   *
   * @type {TrackFields | undefined}
   */
  let start

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
    if (start && child.type === 'html' && htmlKind(child.value) !== 7) {
      // Set only after a string that ends in an eol.
      const previous = /** @type {string} */ (results[results.length - 1])
      const value = previous.replace(/(\r?\n|\r)$/, ' ')
      results[results.length - 1] = value
      before = ' '
      tracker = state.createTracker(start)
      tracker.move(value)
      // It ends in a space now.
      start = undefined
    }

    /** @type {(Handle & {attention?: Attention | undefined}) | undefined} */
    // @ts-expect-error: hush, it’s actually a `zwitch`.
    const handle = state.handle.handlers[child.type]

    if (handle && handle.attention) {
      const pair = attentionItem(
        /** @type {PhrasingParents} */ (child),
        handle.attention,
        state,
        tracker.current()
      )
      tracker = pair[1]
      start = undefined
      results.push(pair[0])
      before = lastCharacter(pair[0].sequences[0])
    } else {
      const value = state.handle(child, parent, state, {
        ...tracker.current(),
        after,
        before
      })

      if (!value) continue
      before = lastCharacter(value)
      start = before === '\r' || before === '\n' ? tracker.current() : undefined
      tracker.move(value)
      results.push(value)
    }
  }

  indexStack.pop()

  return [results, tracker]
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
 * @param {TrackFields} position
 *   Where the node starts.
 * @returns {[AttentionResult, Tracker]}
 *   Attention, and a tracker after it.
 */
export function attentionItem(node, attention, state, position) {
  // Few locals: nesting recurses through here and `phrasing`, on the stack.
  const result = attention(node, state)
  const sequences = attentionSequences(node.type, result.markers, result.sizes)
  const exit = state.enter(result.construct)
  const tracker = state.createTracker(position)
  tracker.move(sequences[0])
  // Positions count what handlers return, not what serializing changes
  // after (other sequences, character references):
  // serializing children again at each level would take quadratic time.
  const pair = phrasing(node, state, {
    ...tracker.current(),
    before: sequences[0],
    after: sequences[0]
  })
  pair[1].move(sequences[0])
  exit()
  return [{children: pair[0], sequences}, pair[1]]
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
    choices: false,
    count: 0,
    found: infinity,
    hollow: false,
    lists: new Map(),
    log: undefined,
    markers: [],
    memos: [],
    memosFrom: 0,
    mistake: -1,
    queue: [],
    runs: new Map(),
    runsFrom: 0,
    size: 1,
    string: 0,
    strings: [],
    time: 0,
    trying: false,
    values: [],
    versions: [],
    worse: false
  }

  place(serialization, items, undefined)
  forget(serialization)
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
      if (!parent) serialization.strings.push(values.length)
      values.push(item)
      attentions.push(undefined)
    } else {
      if (item.children.length === 0) serialization.hollow = true
      if (item.sequences.length > 1) serialization.choices = true

      for (const option of item.sequences) {
        const marker = option.charAt(0)
        if (!serialization.markers.includes(marker)) {
          serialization.markers.push(marker)
        }
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
 * Tries render and pair again only around what they change,
 * so that this takes close to linear time,
 * except in attention nested deeply:
 * its sequences form runs as long as it is deep, which tries pair again,
 * and with text at each level, a try can change how each is encoded,
 * so each try takes time linear in how deep it is.
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
  const {values} = serialization

  // Attention without content never forms,
  // and without other sequences nothing can be tried.
  if (serialization.hollow || !serialization.choices) return values.join('')

  // Most phrasing pairs fast on its own.
  const any = quick(serialization)
  if (any === undefined ? !check(serialization) : !any) return values.join('')

  // Tries change tokens; this is the first rendering, if no try fixes all.
  const initial = [...values]
  plant(serialization)
  let mistake = check(serialization)

  while (mistake) {
    freeze(serialization, mistake[0])
    if (!improve(serialization, ...mistake)) return initial.join('')
    mistake = check(serialization)
  }

  return values.join('')
}

/**
 * Pair the run at a token, if it is one of a marker,
 * or move past tokens up to the next run of it,
 * or, in a try, past the token.
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
    pairing.decided = infinity
    pairing.involved = undefined
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
    const skip = trying ? leaf(pairing.state) : undefined

    // Move past tokens of other markers or strings at once,
    // or one at a time in a try, as the rest may pair as before.
    do {
      if (skip) leaves.push(skip)
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
    pairing.decided = infinity
    pairing.involved = undefined
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
 * @param {boolean} [keep=false]
 *   Whether to keep the leaf where pairing is (default: `false`).
 * @returns {undefined}
 *   Nothing.
 */
function flush(serialization, version, pairing, keep) {
  if (pairing.index === pairing.start || !serialization.trying) return

  // The state where pairing is.
  if (!keep) {
    pairing.leaves.push(leaf(pairing.state))
  }

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
 *   Version, last token that pairs as in it (`infinity` if all do),
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
  let cut = infinity

  for (const other of seen) {
    const {known, tree} = other.version
    let from = infinity
    let far = bound

    if (other.state === here) {
      // Where tokens after are as they were, all pairs as in the version.
      if (bound === infinity) {
        use = other
        cut = infinity
        to = infinity
        break
      }
    } else {
      // Runs that differ pair with nothing until a later run pairs
      // with one of them before,
      // or looks at all of them while it does not skip each of them,
      // following the rule of 3 in `pair`,
      // or, for other markers, while it is of the size of one of them:
      // until then, pair as in the version, with those runs as they are.
      from = differ(serialization, other.state, here) + 1
      const {kinds, skips} = before(here, from)
      // Kinds that do not skip all of them, or, for other markers, their sizes.
      far = Math.min(
        reach(serialization, tree, index, from, split ? 63 - skips : kinds),
        bound
      )
    }

    // Nothing pairs with them until the end, where they do not form.
    let end =
      far === infinity && known === length
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
        cut === infinity
          ? undefined
          : {
              add: divide(serialization, here, cut)[0],
              cut,
              floor: -infinity,
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
 *   State of pairing, for where it is.
 * @param {[Seen, number, Patch | undefined]} found
 *   Version, last token that pairs as in it (`infinity` if all do),
 *   and patch to it with runs of where pairing is.
 * @returns {Pairing}
 *   State of pairing after.
 */
function move(serialization, version, pairing, found) {
  const {index} = pairing
  const [use, to, patch] = found
  const length = serialization.values.length
  const end = to === infinity ? use.version.known : to
  version.tree = splice(
    serialization,
    version.tree,
    use.version.tree,
    index,
    end + 1,
    patch
  )

  if (to === infinity) {
    adopt(version, use.version)
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
 * Take what a version knows from another that pairs as it from where pairing
 * is.
 *
 * @param {Version} version
 *   Version, changed.
 * @param {Version} other
 *   Version to take from.
 * @returns {undefined}
 *   Nothing.
 */
function adopt(version, other) {
  version.end = other.end
  version.known = other.known
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
 *   Sequence, or `infinity`, and the sequences involved.
 */
function ending(serialization, tree) {
  const state = read(serialization, tree, serialization.values.length)
  return state ? [state.wrong, state.list] : [infinity, undefined]
}

/**
 * Find the first run from a token that pairs with a run before another token,
 * or looks at all runs while it is of some kinds.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Tree} tree
 *   Tree of a version.
 * @param {number} from
 *   Token to search from.
 * @param {number} below
 *   Token.
 * @param {number} kinds
 *   Kinds, as bits.
 * @returns {number}
 *   First sequence of that run, or `infinity`.
 */
function reach(serialization, tree, from, below, kinds) {
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
   *   Token, or `infinity`.
   */
  function find(node, start, end) {
    if (end <= from || (node.low >= below && !(node.kinds & kinds))) {
      return infinity
    }

    if (end - start === 1) return start
    const middle = (start + end) / 2
    // Nodes with runs have two halves.
    const left = find(/** @type {Tree} */ (node.left), start, middle)
    return left === infinity
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
    kinds: left.kinds | right.kinds,
    left,
    list: first.list,
    low: Math.min(left.low, right.low),
    right,
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
 * @param {number} [low]
 *   First sequence of the lowest run that the run pairs with to close.
 * @param {number | undefined} [kind]
 *   Kind of the run, if it looks at all runs that can open.
 * @param {number} [wrong]
 *   First sequence that the run decides does not form its attention.
 * @param {List | undefined} [list]
 *   Sequences involved with it.
 * @returns {Tree}
 *   Leaf.
 */
function leaf(state, low = infinity, kind, wrong = infinity, list) {
  return {
    kinds: kind === undefined ? 0 : bit(kind),
    list,
    low,
    patch: undefined,
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
 * Start pairing at the last token at or before one where a version has a
 * snapshot.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Tree} tree
 *   Tree.
 * @param {number} at
 *   Token.
 * @returns {Pairing}
 *   State of pairing.
 */
function resume(serialization, tree, at) {
  /** @type {Snapshot | undefined} */
  let state = null

  while (at > 0 && (state = read(serialization, tree, at)) === undefined) {
    at--
  }

  return restore(at, state || null)
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
 * Drop what caches keep for tokens before the last string outside attention
 * before a mistake.
 * Sequences before a mistake form, so nothing is open at such a string:
 * tries for later mistakes change only it and what comes after,
 * and pair again from the run before it.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {number} mistake
 *   Mistake.
 * @returns {undefined}
 *   Nothing.
 */
function freeze(serialization, mistake) {
  const {lists, memos, runs, strings, versions} = serialization
  const from = serialization.string

  // Mistakes only come later.
  while (
    serialization.string < strings.length &&
    strings[serialization.string] < mistake
  ) {
    serialization.string++
  }

  if (serialization.string === from) return
  const limit = strings[serialization.string - 1] - 1
  // Nothing comes before the first token.
  if (limit < 0) return
  let end = limit
  let first = limit

  for (const {tree} of versions) {
    // Where tries after the string start pairing.
    const {index, state} = resume(serialization, tree, limit)
    end = Math.min(end, index)
    // Runs that are open there are paired again.
    if (state) first = Math.min(first, state.first)
  }

  first = Math.min(first, end)

  // Each token is dropped once for each marker,
  // so this takes linear time in all.
  for (const memo of memos) {
    for (let at = serialization.memosFrom; at < end; at++) memo.delete(at)
  }

  for (let at = serialization.runsFrom; at < first; at++) {
    runs.delete(at)
    lists.delete(at)
  }

  serialization.memosFrom = Math.max(serialization.memosFrom, end)
  serialization.runsFrom = Math.max(serialization.runsFrom, first)
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
    decided: infinity,
    first: infinity,
    index,
    involved: undefined,
    involvedAdded: undefined,
    kind: undefined,
    leaves: [],
    list: undefined,
    listAdded: undefined,
    low: infinity,
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
  forget(serialization)
}

/**
 * Forget pairing.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @returns {undefined}
 *   Nothing.
 */
function forget(serialization) {
  serialization.versions = serialization.markers.map(() => ({
    end: [infinity, undefined],
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
  const {close, end, lists, sizes, start, token} = run
  const runs = nested(serialization.runs, token)

  for (const [index, extra] of run.added) {
    lists[index] = extend(serialization, lists[index], extra)
  }

  run.added.clear()
  // Lists of sequences that are done are used only if they are first.
  const index = lists.findIndex(Boolean)
  const from = sequence(run, start) - token
  const to = sequence(run, end - 1) - token
  // Tries can change the marker of a token, so the lane counts too.
  const key = [
    lane,
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
    // Runs that can open have markers left, so a sequence that is wrong.
    data = {
      close,
      end,
      kind: kindOf(builtins.has(serialization.markers[lane]), run),
      list: lists[index],
      lists,
      nodes: new Map(),
      rank: rank(token),
      sizes,
      skips: skipped(close, (end - start) % 3),
      start,
      token,
      undone: sequence(run, start),
      wrong: token + index
    }
    runs.set(key, data)
  }

  return data
}

/**
 * Get the map at a key of a map, made if needed.
 *
 * @template K
 *   Key of the map at the key.
 * @template T
 *   Value.
 * @param {Map<number, Map<K, T>>} map
 *   Map.
 * @param {number} key
 *   Key.
 * @returns {Map<K, T>}
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
    const priority = at < end ? rank(at) : infinity
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
    added: new Map(),
    close,
    end,
    ends,
    lists: [...lists],
    open: true,
    sizes,
    start,
    token
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

  return run.token + low
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
    const first = below.wrong < infinity ? below : data
    node = {
      data,
      first: left ? left.first : data.token,
      id: ++serialization.count,
      kinds: below.kinds | bit(data.kind) | after.kinds,
      last: right ? right.last : data.token,
      left,
      list: first.list,
      right,
      skips: below.skips & data.skips & after.skips,
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
 * @param {number} kinds
 *   Kinds that pair, as bits.
 * @param {number} size
 *   Size that pairs, for other markers, or `-1`.
 * @returns {boolean}
 *   Whether it pairs.
 */
function fits(kind, kinds, size) {
  return size < 0 ? (bit(kind) & kinds) !== 0 : kind === size
}

/**
 * Get the kinds of runs that a run skips, or that skip it, by the rule of 3:
 * runs with `3 - left` markers left,
 * all of them if the run can open and close, or else those that can.
 *
 * @param {boolean} both
 *   Whether the run can open and close.
 * @param {number} left
 *   Markers left of the run, modulo 3.
 * @returns {number}
 *   Kinds, as bits.
 */
function skipped(both, left) {
  return left ? (both ? 3 : 2) << ((3 - left) * 2) : 0
}

/**
 * Get the bit of a kind;
 * sizes 30 apart share one, so that sets stay small integers.
 *
 * @param {number} kind
 *   Kind.
 * @returns {number}
 *   Bit.
 */
function bit(kind) {
  return 1 << (kind % 30)
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
 * @param {number} kinds
 *   Kinds, as bits.
 * @param {number} size
 *   Size, for other markers, or `-1`.
 * @param {number} from
 *   First sequence of runs to look at.
 * @returns {Data | undefined}
 *   Run, if any.
 */
function last(node, kinds, size, from) {
  if (!node || node.last < from || !(node.kinds & kinds)) return undefined
  const {data} = node
  return (
    last(node.right, kinds, size, from) ||
    (data.token >= from && fits(data.kind, kinds, size) ? data : undefined) ||
    last(node.left, kinds, size, from)
  )
}

/**
 * Get what the runs of a snapshot before a sequence aggregate to.
 *
 * @param {Snapshot} node
 *   Snapshot.
 * @param {number} cut
 *   Sequence.
 * @returns {{kinds: number, skips: number}}
 *   Kinds of the runs, and kinds of runs that skip all of them, as bits.
 */
function before(node, cut) {
  let kinds = 0
  let skips = none.skips

  while (node) {
    if (node.data.token < cut) {
      const below = node.left || none
      kinds |= below.kinds | bit(node.data.kind)
      skips &= below.skips & node.data.skips
      node = node.right
    } else {
      node = node.left
    }
  }

  return {kinds, skips}
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
 *   First sequence of the last run that differs, or `-infinity`.
 */
function differ(serialization, a, b) {
  if (a === b) return -infinity
  if (!a || !b) return /** @type {Entry} */ (a || b).last

  if (a.data.token === b.data.token) {
    const right = differ(serialization, a.right, b.right)
    if (right !== -infinity) return right
    return a.data === b.data
      ? differ(serialization, a.left, b.left)
      : a.data.token
  }

  // The run of the node that goes above is not in the other snapshot.
  const high = a.data.rank > b.data.rank ? a : b
  const low = high === a ? b : a
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
 * Get the index after the run of sequences that has a token.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} index
 *   Sequence in the run.
 * @returns {number}
 *   Index after the run.
 */
function runEnd(serialization, index) {
  const marker = serialization.values[index].charAt(0)
  let end = index + 1

  while (
    end < serialization.values.length &&
    isMarker(serialization, end, marker)
  ) {
    end++
  }

  return end
}

/**
 * Get whether a run of sequences can open and close.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {number} index
 *   First sequence of the run.
 * @param {number} end
 *   Index after the run.
 * @returns {[boolean, boolean]}
 *   Whether it can open, and close.
 */
function flank(serialization, index, end) {
  const {after, before, values} = serialization
  const strict = builtins.get(values[index].charAt(0))
  const head = index ? values[index - 1] : before
  const previous = classifyCharacter(head.charCodeAt(head.length - 1))
  const next = classifyCharacter(
    (end < values.length ? values[end] : after).charCodeAt(0)
  )
  const open = !next || (next === 2 && Boolean(previous))
  const close = !previous || (previous === 2 && Boolean(next))
  // Underscores are strict, they cannot open or close inside words.
  return strict
    ? [open && (Boolean(previous) || !close), close && (Boolean(next) || !open)]
    : [open, close]
}

/**
 * Check whether all sequences form their attention, as `pair` does,
 * but on their own:
 * each closer looks at all runs that can open before it,
 * which is fast unless many runs are skipped.
 *
 * @param {Serialization} serialization
 *   State.
 * @returns {boolean | undefined}
 *   Whether a sequence does not form its attention,
 *   or `undefined` if that takes too long to find out this way.
 */
function quick(serialization) {
  const {attentions, values} = serialization
  // Work that is linear in the tokens.
  let budget = Math.max(64, values.length) * 8
  /** @type {Map<string, Array<{end: number, markers: Array<number>, open: boolean, close: boolean, start: number}>>} */
  const lanes = new Map()
  let formed = 0
  let sequences = 0
  let index = 0

  while (index < values.length) {
    if (attentions[index] === undefined) {
      index++
      continue
    }

    const marker = values[index].charAt(0)
    const split = builtins.has(marker)
    const end = runEnd(serialization, index)
    const [open, close] = flank(serialization, index, end)
    /** @type {Array<number>} */
    const markers = []

    while (index < end) {
      let size = values[index].length
      while (size--) markers.push(index)
      sequences++
      index++
    }

    const closer = {close, end: markers.length, markers, open, start: 0}
    let openers = lanes.get(marker)

    if (!openers) {
      openers = []
      lanes.set(marker, openers)
    }

    let at = close ? openers.length : 0

    while (at-- && closer.start < closer.end) {
      if (--budget < 0) return
      const opener = openers[at]
      const openerSize = opener.end - opener.start
      const closerSize = closer.end - closer.start

      if (
        split
          ? // The rule of 3, on the sizes that are left.
            (opener.close || closer.open) &&
            closerSize % 3 &&
            !((openerSize + closerSize) % 3)
          : // Others pair whole runs of the same size.
            openerSize !== closerSize
      ) {
        continue
      }

      const size = split
        ? openerSize > 1 && closerSize > 1
          ? 2
          : 1
        : closerSize
      const opening = opener.markers[opener.end - size]
      const closing = closer.markers[closer.start]

      // Whole sequences of the same attention.
      if (
        opening !== opener.markers[opener.end - 1] ||
        values[opening].length !== size ||
        closing !== closer.markers[closer.start + size - 1] ||
        values[closing].length !== size ||
        attentions[opening] !== attentions[closing]
      ) {
        return true
      }

      formed += 2
      opener.end -= size
      closer.start += size
      if (opener.start === opener.end) {
        budget -= openers.length - at
        openers.splice(at, 1)
      }

      // Search again from the start, as this run may close more.
      at = openers.length
    }

    if (open && closer.start < closer.end) openers.push(closer)
  }

  return formed < sequences
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
  const {values} = serialization
  const end = runEnd(serialization, index)
  const [open, close] = flank(serialization, index, end)
  /** @type {Run} */
  const run = {
    added: new Map(),
    token: index,
    ends: [],
    lists: [],
    sizes: [],
    start: 0,
    end: 0,
    open,
    close
  }

  const list = range(serialization, index, end)

  for (let at = index; at < end; at++) {
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
    for (const [offset, list] of run.lists.entries()) {
      decide(
        serialization,
        pairing,
        run.token + offset,
        list,
        run.added.get(offset)
      )
    }
  }

  // Lists of sequences done while pairing are made once they are used:
  // checks use the first mistake, trees what runs decide.
  if (serialization.mistake === -1) {
    pairing.list = extend(serialization, pairing.list, pairing.listAdded)
  }

  if (serialization.trying) {
    pairing.involved = extend(
      serialization,
      pairing.involved,
      pairing.involvedAdded
    )
  }

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
 *   Token, or `infinity`.
 */
function undone(serialization, pairing) {
  // At the end, everything is done.
  return pairing.state && pairing.index < serialization.values.length
    ? pairing.state.undone
    : infinity
}

/**
 * Get the first sequence that a version decides does not form its attention.
 *
 * @param {Serialization} serialization
 *   State.
 * @param {Version} version
 *   Version.
 * @returns {[number, List | undefined]}
 *   Sequence, or `infinity`, and the sequences involved.
 */
function wrongs(serialization, version) {
  const {known} = version
  /** @type {[number, List | undefined]} */
  const result =
    known === serialization.values.length
      ? [...version.end]
      : [infinity, undefined]
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
