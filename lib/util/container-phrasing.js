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
 * @typedef Token
 *   Rendered phrasing.
 * @property {AttentionResult | undefined} attention
 *   Attention, if this is one of its sequences.
 * @property {string} value
 *   Value.
 */

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
 * @typedef RenderContext
 *   State of rendering between items.
 * @property {Array<Token>} tokens
 *   Tokens so far.
 * @property {string | undefined} encodeAfter
 *   Character to encode if the next item starts with it.
 * @property {string} previous
 *   Last character so far.
 */

/**
 * @typedef {(attention: AttentionResult) => string} Choose
 *   Get the sequence to use for attention.
 */

/**
 * @typedef ScanRun
 *   Sequences next to each other with the same marker, by token index.
 * @property {boolean} close
 *   Whether it can close.
 * @property {number} end
 *   Index after the last marker not used (to open).
 * @property {Array<number>} markers
 *   Token index of each marker.
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
 *   Result of pairing a range of tokens.
 * @property {Array<number>} empty
 *   Indices of runs before which nothing is open.
 * @property {number} first
 *   Index of the first sequence that does not form its attention, or `-1`.
 * @property {Array<number>} involved
 *   Sequences involved with that sequence.
 * @property {number} stop
 *   Index where scanning stopped.
 */

/**
 * Pair runs of sequences like `micromark`, from a token where nothing is open,
 * until it is known which sequence is the first that does not form its
 * attention.
 *
 * Sequences of `*` and `_` pair like emphasis and strong in CommonMark,
 * others like strikethrough in GFM.
 * Each pair uses markers from the end of an opener and the start of a closer.
 * It forms the intended attention if those markers are exactly the whole
 * opening and closing sequence of one attention.
 * Otherwise the sequences involved are recorded with each other.
 *
 * @param {(index: number) => Token} tokenAt
 *   Get a token.
 * @param {number} length
 *   Number of tokens.
 * @param {number} from
 *   Index to start at: the first token, or the first sequence of a run before
 *   which nothing is open.
 * @param {string} before
 *   Characters before the tokens.
 * @param {string} after
 *   Characters after the tokens.
 * @returns {Scan}
 *   Result.
 */
function scan(tokenAt, length, from, before, after) {
  /** @type {Map<string, Array<ScanRun>>} */
  const openersByMarker = new Map()
  /** @type {Map<number, Array<number>>} */
  const wrong = new Map()
  /** @type {Array<number>} */
  const empty = []
  /** @type {Array<ScanRun>} */
  const pending = []
  let first = -1
  let index = from

  /**
   * Note that the sequences of a run are done pairing.
   *
   * @param {ScanRun} run
   *   Run.
   * @returns {undefined}
   *   Nothing.
   */
  function done(run) {
    for (const at of run.tokens) {
      if (wrong.has(at) && (first === -1 || at < first)) first = at
    }
  }

  /**
   * Check whether the first mistake is known.
   *
   * @returns {boolean}
   *   Whether the first mistake is known.
   */
  function known() {
    if (first === -1) return false
    for (const run of pending) {
      for (const at of run.tokens) {
        if (at < first && wrong.has(at)) return false
      }
    }

    return true
  }

  while (index < length) {
    const token = tokenAt(index)

    if (!token.attention) {
      index++
      continue
    }

    if (pending.length === 0) empty.push(index)

    const marker = token.value.charAt(0)
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
    const canOpen = !next || (next === 2 && Boolean(previous))
    const canClose = !previous || (previous === 2 && Boolean(next))
    /** @type {Array<number>} */
    const tokens = []
    /** @type {ScanRun} */
    const closer = {
      tokens,
      markers: [],
      start: 0,
      end: 0,
      // Underscores are strict, they cannot open or close inside words.
      open: strict ? canOpen && (Boolean(previous) || !canClose) : canOpen,
      close: strict ? canClose && (Boolean(next) || !canOpen) : canClose,
      // All builtins can split runs.
      split: strict !== undefined
    }

    for (let at = index; at < end; at++) tokens.push(at)

    for (const at of tokens) {
      // Every sequence is wrong until it pairs with its other sequence.
      wrong.set(at, [...tokens])
      let size = tokenAt(at).value.length
      while (size--) closer.markers.push(at)
    }

    closer.end = closer.markers.length

    let openers = openersByMarker.get(marker)

    if (!openers) {
      openers = []
      openersByMarker.set(marker, openers)
    }

    let at = closer.close ? openers.length : 0

    while (at-- && closer.start < closer.end) {
      const opener = openers[at]
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
      const openIndex = opening[0]
      const closeIndex = closing[0]

      if (
        // Whole sequences:
        // the markers of a sequence are next to each other,
        // so if the first and last marker are of one sequence of that size,
        // all markers are exactly that sequence.
        openIndex === opening[size - 1] &&
        tokenAt(openIndex).value.length === size &&
        closeIndex === closing[size - 1] &&
        tokenAt(closeIndex).value.length === size &&
        // Of the same attention, so its opening and closing sequence.
        tokenAt(openIndex).attention === tokenAt(closeIndex).attention
      ) {
        wrong.delete(openIndex)
        wrong.delete(closeIndex)
      } else {
        const involved = [...new Set([...opening, ...closing])]
        // Add to what is involved already: a sequence can be in several pairs.
        for (const one of involved) {
          const list = wrong.get(one)
          if (list) list.push(...involved)
        }
      }

      opener.end -= size
      closer.start += size

      if (opener.start === opener.end) {
        openers.splice(at, 1)
        pending.splice(pending.indexOf(opener), 1)
        done(opener)
      }

      // Search again from the start, as this run may close more.
      at = openers.length
    }

    if (closer.open && closer.start < closer.end) {
      openers.push(closer)
      pending.push(closer)
    } else {
      done(closer)
    }

    index = end
    if (known()) break
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
    tokens: [],
    encodeAfter: undefined,
    previous: lastCharacter(before)
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

  tokens.push({value: sequence, attention: item}, ...inside, {
    value: sequence,
    attention: item
  })
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
 * Changing the sequence of attention changes the tokens of the top-level item
 * it is in and those next to it,
 * and how runs pair until the next point where nothing is open.
 * So a try only renders and pairs that part again.
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
  /** @type {Map<AttentionResult, string>} */
  const chosen = new Map()
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

  /** @type {RenderContext} */
  const context = {
    tokens: [],
    encodeAfter: undefined,
    previous: lastCharacter(before)
  }
  // For each item: its first token, and the state of rendering before it,
  // including the value of the token before it, before it is encoded.
  /** @type {Array<number>} */
  const starts = []
  /** @type {Array<string>} */
  const previouses = []
  /** @type {Array<string | undefined>} */
  const encodeAfters = []
  /** @type {Array<string | undefined>} */
  const lasts = []
  let index = -1

  while (++index < items.length) {
    const tokens = context.tokens
    starts.push(tokens.length)
    previouses.push(context.previous)
    encodeAfters.push(context.encodeAfter)
    lasts.push(tokens.length > 0 ? tokens[tokens.length - 1].value : undefined)
    renderItem(items, index, preferred, after, context)
  }

  const tokens = context.tokens
  const length = tokens.length
  starts.push(length)
  const initial = join(tokens)

  /** @type {Map<AttentionResult, number>} */
  const top = new Map()
  /** @type {Map<AttentionResult, [number, number]>} */
  const positions = new Map()

  index = -1
  while (++index < items.length) {
    const item = items[index]
    if (typeof item !== 'string') tops(item, index, top)
  }

  index = -1
  while (++index < length) {
    const attention = tokens[index].attention
    if (!attention) continue
    const found = positions.get(attention)
    if (found) found[1] = index
    else positions.set(attention, [index, index])
  }

  // Pairing of the current tokens, known before `known`:
  // which tokens start a run before which nothing is open.
  const empty = new Uint8Array(length)
  let known = 0
  let result = scan((at) => tokens[at], length, 0, before, after)
  apply(result, 0)

  while (result.first !== -1) {
    const next = improve(result.first, result.involved)
    if (!next) return initial
    result = next
  }

  return join(tokens)

  /**
   * Use a scan of the current tokens.
   *
   * @param {Scan} scanned
   *   Scan.
   * @param {number} from
   *   Where it started.
   * @returns {undefined}
   *   Nothing.
   */
  function apply(scanned, from) {
    empty.fill(0, from, scanned.stop)
    for (const at of scanned.empty) empty[at] = 1
    known = scanned.stop
  }

  /**
   * Try other sequences for the candidates of a mistake and use the first that
   * moves the mistake further.
   *
   * @param {number} mistake
   *   Index of the first sequence that does not form its attention.
   * @param {Array<number>} involved
   *   Sequences involved with it.
   * @returns {Scan | undefined}
   *   Scan of the new tokens, if better.
   */
  function improve(mistake, involved) {
    for (const attention of candidates(involved)) {
      const current = preferred(attention)

      for (const sequence of attention.sequences) {
        if (sequence === current) continue
        const next = attempt(attention, sequence, mistake)
        if (next) return next
      }
    }
  }

  /**
   * Get candidates for a mistake:
   * attention to try other sequences for,
   * later first.
   *
   * @param {Array<number>} involved
   *   Sequences involved in the mistake.
   * @returns {Array<AttentionResult>}
   *   Candidates.
   */
  function candidates(involved) {
    /** @type {Set<AttentionResult>} */
    const attentions = new Set()
    /** @type {Set<AttentionResult>} */
    const related = new Set()

    for (const at of involved) {
      const attention = tokens[at].attention
      if (attention) attentions.add(attention)
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
        while (end < length && isMarker(tokens[end], marker)) end++
        while (start < end) {
          related.add(
            /** @type {AttentionResult} */ (tokens[start++].attention)
          )
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
   * Try a sequence for attention.
   *
   * @param {AttentionResult} attention
   *   Attention.
   * @param {string} sequence
   *   Sequence to try.
   * @param {number} mistake
   *   Index of the mistake.
   * @returns {Scan | undefined}
   *   Scan of the new tokens, if better.
   */
  function attempt(attention, sequence, mistake) {
    /**
     * Get the sequence to try for attention.
     *
     * @param {AttentionResult} other
     *   Attention.
     * @returns {string}
     *   Sequence.
     */
    function choose(other) {
      return other === attention ? sequence : preferred(other)
    }

    const changed = /** @type {number} */ (top.get(attention))
    const first = Math.max(0, changed - 1)
    const copy = starts[first] > 0
    /** @type {RenderContext} */
    const context = {
      tokens: copy
        ? [
            {
              value: /** @type {string} */ (lasts[first]),
              attention: tokens[starts[first] - 1].attention
            }
          ]
        : [],
      encodeAfter: encodeAfters[first],
      previous: previouses[first]
    }
    const offset = starts[first] - (copy ? 1 : 0)
    /** @type {Array<[number, string, string | undefined, string | undefined]>} */
    const records = []
    let last = first
    let end = length

    while (last < items.length) {
      renderItem(items, last, choose, after, context)
      last++
      if (last === items.length) continue
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
    /**
     * Get a token, new where it changed.
     *
     * @param {number} at
     *   Index.
     * @returns {Token}
     *   Token.
     */
    function tokenAt(at) {
      return at >= offset && at < end ? fresh[at - offset] : tokens[at]
    }

    // Start pairing where nothing is open, before any change.
    // Pairing stops right after the mistake is known,
    // so that is not after the mistake.
    let from = Math.min(offset, known) - 1
    while (from > 0 && empty[from] === 0) from--
    from = Math.max(from, 0)
    const scanned = scan(tokenAt, length, from, before, after)

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

    apply(scanned, from)
    return scanned
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
 * Map attention, deep, to the index of the top-level item it is in.
 *
 * @param {AttentionResult} attention
 *   Attention.
 * @param {number} index
 *   Index of the top-level item.
 * @param {Map<AttentionResult, number>} top
 *   Map, changed.
 * @returns {undefined}
 *   Nothing.
 */
function tops(attention, index, top) {
  top.set(attention, index)
  for (const child of attention.children) {
    if (typeof child !== 'string') tops(child, index, top)
  }
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
