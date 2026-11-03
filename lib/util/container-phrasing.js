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
 * @typedef {(attention: AttentionResult) => string} Choose
 *   Get the sequence to use for attention.
 */

/**
 * @typedef {AttentionResult | string} Item
 *   Serialized phrasing.
 */

/**
 * @typedef RenderContext
 *   State of rendering between items.
 * @property {string | undefined} encodeAfter
 *   Character to encode if the next item starts with it.
 * @property {string} previous
 *   Last character so far.
 * @property {Array<Token>} tokens
 *   Tokens so far.
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
 * @typedef Scan
 *   Result of checking tokens.
 * @property {Array<number>} empty
 *   Indices of runs before which nothing is open.
 * @property {number} first
 *   Index of the first sequence that does not form its attention, or `-1`.
 * @property {Array<number>} involved
 *   Sequences involved with that sequence.
 * @property {number} stop
 *   Index where checking stopped.
 */

/**
 * @typedef Serialization
 *   State of serializing phrasing with attention.
 * @property {string} after
 *   Characters after.
 * @property {string} before
 *   Characters before.
 * @property {Map<AttentionResult, string>} chosen
 *   Sequences to use instead of preferred sequences.
 * @property {Uint8Array} empty
 *   Whether nothing is open before each token, up to `known`.
 * @property {Array<string | undefined>} encodeAfters
 *   Character to encode at the start of each item.
 * @property {Array<Item>} items
 *   Phrasing items.
 * @property {number} known
 *   Index up to which `empty` is known.
 * @property {Array<string | undefined>} lasts
 *   Value of the token before each item, before that item encodes it.
 * @property {Map<AttentionResult, [number, number]>} positions
 *   Index of the opening and closing sequence of each attention.
 * @property {Array<string>} previouses
 *   Character before each item.
 * @property {Array<number>} starts
 *   Index of the first token of each item, and of the end.
 * @property {Array<Token>} tokens
 *   Tokens.
 * @property {Map<AttentionResult, number>} top
 *   Index of the top-level item that each attention is in.
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
 * @param {Array<Token>} tokens
 *   Tokens.
 * @param {Array<number>} involved
 *   Sequences involved in the mistake.
 * @param {Map<AttentionResult, [number, number]>} positions
 *   Index of the opening and closing sequence of each attention.
 * @returns {Array<AttentionResult>}
 *   Candidates.
 */
function candidates(tokens, involved, positions) {
  /** @type {Set<AttentionResult>} */
  const attentions = new Set()
  /** @type {Set<AttentionResult>} */
  const related = new Set()

  for (const at of involved) {
    attentions.add(/** @type {AttentionResult} */ (tokens[at].attention))
  }

  // The attention involved, and attention in runs with its sequences.
  for (const attention of attentions) {
    for (const at of /** @type {[number, number]} */ (
      positions.get(attention)
    )) {
      const marker = tokens[at].value.charAt(0)
      let start = at
      let end = at + 1
      while (start > 0 && isMarker(tokens[start - 1], marker)) start--
      while (end < tokens.length && isMarker(tokens[end], marker)) end++

      while (start < end) {
        related.add(/** @type {AttentionResult} */ (tokens[start++].attention))
      }
    }
  }

  // Later first: attention that opens later is inner or next.
  return [...related].sort(
    (a, b) =>
      /** @type {[number, number]} */ (positions.get(b))[0] -
      /** @type {[number, number]} */ (positions.get(a))[0]
  )
}

/**
 * Check whether sequences form their attention, like `micromark`,
 * from a token before which nothing is open,
 * until the first sequence that does not is known.
 *
 * Sequences of `*` and `_` pair like emphasis and strong in CommonMark,
 * others like strikethrough in GFM.
 *
 * @param {(index: number) => Token} tokenAt
 *   Get a token.
 * @param {number} length
 *   Number of tokens.
 * @param {number} from
 *   Index to start at.
 * @param {string} before
 *   Characters before.
 * @param {string} after
 *   Characters after.
 * @returns {Scan}
 *   Result.
 */
function check(tokenAt, length, from, before, after) {
  /** @type {Map<string, Array<Run>>} */
  const openersByMarker = new Map()
  /** @type {Map<number, Array<number>>} */
  const wrong = new Map()
  /** @type {Array<number>} */
  const empty = []
  /** @type {Array<Run>} */
  const pending = []
  let first = -1
  let index = from

  /**
   * Note that the sequences of a run are done pairing.
   *
   * @param {Run} run
   *   Run.
   * @returns {undefined}
   *   Nothing.
   */
  function done(run) {
    const at = pending.indexOf(run)
    if (at !== -1) pending.splice(at, 1)

    for (const token of run.tokens) {
      if (wrong.has(token) && (first === -1 || token < first)) first = token
    }
  }

  while (index < length) {
    if (!tokenAt(index).attention) {
      index++
      continue
    }

    if (pending.length === 0) empty.push(index)

    const marker = tokenAt(index).value.charAt(0)
    const strict = builtins.get(marker)
    let end = index + 1

    while (
      end < length &&
      tokenAt(end).attention &&
      tokenAt(end).value.charAt(0) === marker
    ) {
      end++
    }

    const head = index ? tokenAt(index - 1).value : before
    const previous = classifyCharacter(head.charCodeAt(head.length - 1))
    const next = classifyCharacter(
      (end < length ? tokenAt(end).value : after).charCodeAt(0)
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
      wrong.set(at, [...run.tokens])
      let size = tokenAt(at).value.length
      while (size--) run.markers.push(at)
    }

    run.end = run.markers.length

    let openers = openersByMarker.get(marker)

    if (!openers) {
      openers = []
      openersByMarker.set(marker, openers)
    }

    pair(openers, run, tokenAt, wrong, done)

    if (run.open && run.start < run.end) {
      openers.push(run)
      pending.push(run)
    } else {
      done(run)
    }

    index = end

    // Stop once no sequence before the first mistake can still be wrong.
    if (
      first !== -1 &&
      pending.every((run) =>
        run.tokens.every((at) => !(at < first && wrong.has(at)))
      )
    ) {
      break
    }
  }

  // At the end, what is still open does not form.
  if (index >= length) {
    for (const run of pending) done(run)
  }

  return {
    empty,
    first,
    involved:
      first === -1 ? [] : /** @type {Array<number>} */ (wrong.get(first)),
    stop: index
  }
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
 * Encode the first or last character of tokens as a character reference,
 * if it is text.
 *
 * @param {Array<Token>} tokens
 *   Tokens.
 * @param {boolean} start
 *   Whether to encode the first or last character.
 * @returns {undefined}
 *   Nothing.
 */
function encode(tokens, start) {
  const token = tokens[start ? 0 : tokens.length - 1]

  if (!token || token.attention) return

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
 * @param {Scan} mistake
 *   Mistake.
 * @returns {Scan | undefined}
 *   Result if better.
 */
function improve(serialization, mistake) {
  const {chosen, positions, tokens} = serialization

  for (const attention of candidates(tokens, mistake.involved, positions)) {
    const current = chosen.get(attention) || attention.sequences[0]

    for (const sequence of attention.sequences) {
      if (sequence === current) continue
      const next = attempt(serialization, attention, sequence, mistake.first)
      if (next) return next
    }
  }
}

/**
 * Try a sequence for attention.
 *
 * Changing the sequence of attention changes the tokens of the top-level item
 * it is in and those next to it,
 * and how runs pair from the last point before it where nothing is open.
 * So this renders and checks only that part again.
 *
 * @param {Serialization} serialization
 *   State, changed if better.
 * @param {AttentionResult} attention
 *   Attention.
 * @param {string} sequence
 *   Sequence to try.
 * @param {number} mistake
 *   Index of the mistake.
 * @returns {Scan | undefined}
 *   Result if better.
 */
function attempt(serialization, attention, sequence, mistake) {
  const {after, before, chosen, items, tokens} = serialization
  const {empty, encodeAfters, lasts, previouses, starts} = serialization
  const changed = /** @type {number} */ (serialization.top.get(attention))
  const first = Math.max(0, changed - 1)
  const copy = starts[first] > 0
  /** @type {RenderContext} */
  const context = {
    encodeAfter: encodeAfters[first],
    previous: previouses[first],
    // The token before is encoded again by the first item.
    tokens: copy
      ? [
          {
            value: /** @type {string} */ (lasts[first]),
            attention: tokens[starts[first] - 1].attention
          }
        ]
      : []
  }
  const offset = starts[first] - (copy ? 1 : 0)
  /** @type {Array<[number, string, string | undefined, string]>} */
  const records = []
  let last = first
  let end = tokens.length

  /**
   * Get the sequence to try for attention.
   *
   * @param {AttentionResult} other
   *   Attention.
   * @returns {string}
   *   Sequence.
   */
  function choose(other) {
    return other === attention
      ? sequence
      : chosen.get(other) || other.sequences[0]
  }

  while (last < items.length) {
    renderItem(items, last, choose, after, context)
    last++
    if (last === items.length) break
    const value = context.tokens[context.tokens.length - 1].value
    records.push([last, context.previous, context.encodeAfter, value])

    // Where rendering is as before, the rest is too.
    if (
      last > changed + 1 &&
      context.previous === previouses[last] &&
      context.encodeAfter === encodeAfters[last] &&
      value === lasts[last]
    ) {
      // The token before `last` is encoded by `last` as before.
      context.tokens.pop()
      end = starts[last] - 1
      break
    }
  }

  const fresh = context.tokens
  // Check from where nothing is open before the change,
  // which is not after the mistake as checking stops right after it.
  let from = Math.min(offset, serialization.known) - 1
  while (from > 0 && empty[from] === 0) from--
  from = Math.max(from, 0)
  const scanned = check(
    (at) => (at >= offset && at < end ? fresh[at - offset] : tokens[at]),
    tokens.length,
    from,
    before,
    after
  )

  if (scanned.first !== -1 && scanned.first <= mistake) return

  // Use it.
  chosen.set(attention, sequence)
  let at = offset - 1
  while (++at < end) tokens[at] = fresh[at - offset]

  for (const [item, previous, encodeAfter, value] of records) {
    previouses[item] = previous
    encodeAfters[item] = encodeAfter
    lasts[item] = value
  }

  apply(serialization, scanned, from)
  return scanned
}

/**
 * Use the result of checking tokens.
 *
 * @param {Serialization} serialization
 *   State, changed.
 * @param {Scan} scanned
 *   Result of checking.
 * @param {number} from
 *   Where checking started.
 * @returns {undefined}
 *   Nothing.
 */
function apply(serialization, scanned, from) {
  serialization.empty.fill(0, from, scanned.stop)
  for (const at of scanned.empty) serialization.empty[at] = 1
  serialization.known = scanned.stop
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
 * @param {Array<Run>} openers
 *   Runs that can open, changed.
 * @param {Run} closer
 *   Run.
 * @param {(index: number) => Token} tokenAt
 *   Get a token.
 * @param {Map<number, Array<number>>} wrong
 *   Sequences that are wrong, with the sequences involved.
 * @param {(run: Run) => undefined} done
 *   Called with each opener that is used up.
 * @returns {undefined}
 *   Nothing, `wrong` is changed.
 */
function pair(openers, closer, tokenAt, wrong, done) {
  let open = closer.close ? openers.length : 0

  while (open-- && closer.start < closer.end) {
    const opener = openers[open]
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
      tokenAt(openAt).value.length === size &&
      closeAt === closing[size - 1] &&
      tokenAt(closeAt).value.length === size &&
      // Of the same attention, so its opening and closing sequence.
      tokenAt(openAt).attention === tokenAt(closeAt).attention
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

    if (opener.start === opener.end) {
      openers.splice(open, 1)
      done(opener)
    }

    // Search again from the start, as this run may close more.
    open = openers.length
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
 * Render items with sequences;
 * encoding characters around attention where needed.
 *
 * @param {Array<Item>} items
 *   Serialized phrasing.
 * @param {Choose} choose
 *   Get the sequence to use for attention.
 * @param {string} before
 *   Characters before.
 * @param {string} after
 *   Characters after.
 * @returns {Array<Token>}
 *   Tokens.
 */
function render(items, choose, before, after) {
  /** @type {RenderContext} */
  const context = {
    encodeAfter: undefined,
    previous: lastCharacter(before),
    tokens: []
  }
  let index = -1

  while (++index < items.length) {
    renderItem(items, index, choose, after, context)
  }

  return context.tokens
}

/**
 * Render an item.
 *
 * @param {Array<Item>} items
 *   Serialized phrasing.
 * @param {number} index
 *   Index of the item.
 * @param {Choose} choose
 *   Get the sequence to use for attention.
 * @param {string} after
 *   Characters after the items.
 * @param {RenderContext} context
 *   State between items, changed.
 * @returns {undefined}
 *   Nothing.
 */
function renderItem(items, index, choose, after, context) {
  const tokens = context.tokens
  const item = items[index]

  if (typeof item === 'string') {
    /** @type {Token} */
    const token = {value: item, attention: undefined}

    // If attention before had to encode the character after it, encode it.
    if (context.encodeAfter && context.encodeAfter === firstCharacter(item)) {
      encode([token], true)
    }

    context.encodeAfter = undefined
    tokens.push(token)
    if (token.value) context.previous = lastCharacter(token.value)
    return
  }

  const sequence = choose(item)
  const marker = sequence.charAt(0)
  const next = items[index + 1]
  const outsideBefore = context.previous
  const outsideAfter = firstCharacter(
    next === undefined ? after : typeof next === 'string' ? next : choose(next)
  )
  const inside = render(item.children, choose, sequence, sequence)
  const head = inside.length > 0 ? inside[0].value : ''
  const open = encodeInfo(
    outsideBefore.charCodeAt(outsideBefore.length - 1),
    head.charCodeAt(0),
    marker
  )

  if (open.inside) encode(inside, true)

  const tail =
    inside.length > 0 ? lastCharacter(inside[inside.length - 1].value) : ''
  const close = encodeInfo(
    outsideAfter.charCodeAt(0),
    tail.charCodeAt(tail.length - 1),
    marker
  )

  if (close.inside) encode(inside, false)

  if (open.outside && outsideBefore !== '\n' && outsideBefore !== '\r') {
    encode(tokens, false)
  }

  if (close.outside) context.encodeAfter = outsideAfter

  // Not `push(...inside)`: that fails for very many tokens.
  tokens.push({value: sequence, attention: item})
  for (const token of inside) tokens.push(token)
  tokens.push({value: sequence, attention: item})
  context.previous = sequence.charAt(sequence.length - 1)
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
  /** @type {Serialization} */
  const serialization = {
    after,
    before,
    chosen: new Map(),
    empty: new Uint8Array(0),
    encodeAfters: [],
    items,
    known: 0,
    lasts: [],
    positions: new Map(),
    previouses: [],
    starts: [],
    tokens: [],
    top: new Map()
  }
  const {chosen, encodeAfters, lasts, positions, previouses, starts, tokens} =
    serialization
  /** @type {RenderContext} */
  const context = {
    encodeAfter: undefined,
    previous: lastCharacter(before),
    tokens
  }
  let hollow = false
  let index = -1

  while (++index < items.length) {
    const item = items[index]
    if (typeof item !== 'string' && tops(item, index, serialization.top)) {
      hollow = true
    }

    // The state of rendering before each item,
    // including the value of the token before it, before it is encoded.
    starts.push(tokens.length)
    previouses.push(context.previous)
    encodeAfters.push(context.encodeAfter)
    lasts.push(tokens.length > 0 ? tokens[tokens.length - 1].value : undefined)
    renderItem(items, index, preferred, after, context)
  }

  const initial = join(tokens)

  // Attention without content never forms.
  if (hollow) return initial

  starts.push(tokens.length)
  serialization.empty = new Uint8Array(tokens.length)
  index = -1

  while (++index < tokens.length) {
    const attention = tokens[index].attention
    if (!attention) continue
    const found = positions.get(attention)
    if (found) found[1] = index
    else positions.set(attention, [index, index])
  }

  let mistake = check((at) => tokens[at], tokens.length, 0, before, after)
  apply(serialization, mistake, 0)

  while (mistake.first !== -1) {
    const next = improve(serialization, mistake)
    if (!next) return initial
    mistake = next
  }

  return join(tokens)

  /**
   * Get the current sequence of attention.
   *
   * @param {AttentionResult} attention
   *   Attention.
   * @returns {string}
   *   Sequence.
   */
  function preferred(attention) {
    return chosen.get(attention) || attention.sequences[0]
  }
}

/**
 * Check whether a token is a sequence of a marker.
 *
 * @param {Token} token
 *   Token.
 * @param {string} marker
 *   Marker.
 * @returns {boolean}
 *   Whether it is.
 */
function isMarker(token, marker) {
  return Boolean(token.attention) && token.value.charAt(0) === marker
}

/**
 * Join tokens.
 *
 * @param {Array<Token>} tokens
 *   Tokens.
 * @returns {string}
 *   Value.
 */
function join(tokens) {
  let result = ''
  for (const token of tokens) result += token.value
  return result
}

/**
 * Map attention, deep, to the index of the top-level item it is in.
 *
 * @param {AttentionResult} attention
 *   Attention.
 * @param {number} index
 *   Index of the top-level item.
 * @param {Map<AttentionResult, number>} top
 *   Map, changed.
 * @returns {boolean}
 *   Whether there is attention without content.
 */
function tops(attention, index, top) {
  let hollow = attention.children.length === 0
  top.set(attention, index)

  for (const child of attention.children) {
    if (typeof child !== 'string' && tops(child, index, top)) hollow = true
  }

  return hollow
}
