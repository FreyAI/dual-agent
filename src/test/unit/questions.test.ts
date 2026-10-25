import '../helpers/vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Interactions, editedPlanText } from '../../agent/interactions';
import { answeredInput, normalizeQuestions } from '../../questions';

const ok = (input: unknown) => {
  const r = normalizeQuestions(input);
  assert.ok('questions' in r, `expected questions, got ${JSON.stringify(r)}`);
  return r.questions;
};

test('a well-formed question passes through unchanged', () => {
  const q = { question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite', description: 'File based' }] };
  assert.deepEqual(ok({ questions: [q] }), [q]);
});

test('loose shapes from the model are repaired', () => {
  const qs = ok({
    questions: JSON.stringify([
      { text: 'Which framework should we use for the UI?', options: ['React', { title: 'Vue', desc: 'Lighter' }, 'Other'], multiSelect: 'true' },
    ]),
  });
  assert.equal(qs.length, 1);
  assert.equal(qs[0].question, 'Which framework should we use for the UI?');
  assert.deepEqual(qs[0].options, [{ label: 'React', description: '' }, { label: 'Vue', description: 'Lighter' }], 'strings become options; "Other" is the chat\'s own');
  assert.equal(qs[0].multiSelect, true);
  assert.ok(qs[0].header.length <= 12 && qs[0].header.length > 0, `made-up header "${qs[0].header}"`);
});

test('a single question object (not in a list) is accepted', () => {
  assert.equal(ok({ questions: { question: 'Proceed?', header: 'Go', options: ['Yes', 'No'] } }).length, 1);
});

test('limits: at most 4 questions and 4 options, headers at most 12 characters, no duplicates', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ question: `Question ${i}?`, header: 'A very long header indeed', options: ['a', 'b', 'c', 'd', 'e', 'a'] }));
  const qs = ok({ questions: [...many, many[0]] });
  assert.equal(qs.length, 4);
  assert.deepEqual(qs[0].options.map((o) => o.label), ['a', 'b', 'c', 'd']);
  assert.equal(qs[0].header, 'A very long ');
});

test('questions that can\'t be shown are explained, not shown broken', () => {
  assert.deepEqual(normalizeQuestions({}), { error: 'no questions were given' });
  assert.deepEqual(normalizeQuestions({ questions: '{not json' }), { error: 'the questions were not valid JSON' });
  assert.match((normalizeQuestions({ questions: [{ question: 'Only one option?', options: ['yes'] }] }) as any).error, /at least two options/);
  // A broken question is dropped while a good one stays.
  assert.equal(ok({ questions: [{ question: 'Bad?', options: [] }, { question: 'Good?', options: ['x', 'y'] }] })[0].question, 'Good?');
});

test('answers go back keyed by the exact question text, with notes as annotations', () => {
  const questions = ok({ questions: [{ question: 'Which color?', header: 'Color', options: ['Red', 'Blue'] }, { question: 'Which sizes?', header: 'Sizes', multiSelect: true, options: ['S', 'M', 'L'] }] });
  const input = answeredInput({ questions: 'original', metadata: { source: 'x' } }, questions, {
    answers: { 'Which color?': 'Blue', 'Which sizes?': 'S, L', 'Not asked?': 'ignored' },
    notes: { 'Which color?': 'navy if possible', 'Which sizes?': '  ' },
  });
  assert.deepEqual(input.answers, { 'Which color?': 'Blue', 'Which sizes?': 'S, L' });
  assert.deepEqual(input.annotations, { 'Which color?': { notes: 'navy if possible' } });
  assert.deepEqual(input.questions, questions, 'the cleaned questions are sent back so the keys match');
  assert.deepEqual(input.metadata, { source: 'x' });
});

const planCards = () => {
  const posted: any[] = [];
  let approved = 0;
  const cards = new Interactions((m) => posted.push(m), () => undefined, () => [], () => approved++);
  const review = (decide: (id: string) => void) => {
    const p = cards.ask('ExitPlanMode', { plan: '1. A\n2. B' }, { signal: new AbortController().signal });
    decide(posted.find((m) => m.type === 'planReview').id);
    return p;
  };
  return { posted, review, cards, approvals: () => approved };
};

test('editedPlanText numbers the steps and drops blanks', () => {
  assert.equal(editedPlanText(['  B ', '', 'C\nd']), 'The user edited the plan. Follow this plan instead:\n1. B\n2. C d');
});

test('an unedited plan approval allows the call as before', async () => {
  const { review, cards, posted, approvals } = planCards();
  const r = await review((id) => cards.decidePlan(id, true));
  assert.deepEqual(r, { behavior: 'allow', updatedInput: { plan: '1. A\n2. B' } });
  assert.equal(approvals(), 1);
  assert.deepEqual(posted.at(-1), { type: 'planResolved', id: posted[0].id, plan: '1. A\n2. B', approved: true, feedback: undefined });
});

test('an edited plan approval leaves plan mode and hands the agent the edited steps', async () => {
  const { review, cards, posted, approvals } = planCards();
  const r = await review((id) => cards.decidePlan(id, true, editedPlanText(['B', 'C'])));
  assert.equal(r.behavior, 'deny');
  assert.match((r as any).message, /approved the plan with edits[^]*Follow this plan instead:\n1\. B\n2\. C$/);
  assert.equal(approvals(), 1);
  assert.equal(posted.at(-1).plan, '1. B\n2. C');
  assert.equal(posted.at(-1).approved, true);
});

test('a plan sent back with feedback is unchanged', async () => {
  const { review, cards, approvals } = planCards();
  const r = await review((id) => cards.decidePlan(id, false, 'Also docs'));
  assert.deepEqual(r, { behavior: 'deny', message: 'The user wants changes to the plan before you start: Also docs' });
  assert.equal(approvals(), 0);
});
