import { afterEach, describe as describeTests, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { github } from './github';
import { ProviderError } from './types';
import { describe } from '../model';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const ctx = () => ({ config: {}, signal: new AbortController().signal });
const issue = {
  __typename: 'Issue', title: 'Fix login', state: 'OPEN', stateReason: null,
  url: 'https://github.com/o/r/issues/2', updatedAt: '2026-01-01',
  assignees: { nodes: [{ login: 'zoe' }, { login: 'alice' }] },
  labels: { nodes: [{ name: 'bug' }] }, comments: { totalCount: 0, nodes: [] },
};
function reply(item: unknown) {
  vi.mocked(execFile).mockImplementation((...args: any[]) => {
    args.at(-1)(null, { stdout: JSON.stringify({ data: { repository: { issueOrPullRequest: item } } }) });
    return {} as any;
  });
}
afterEach(() => vi.mocked(execFile).mockReset());
it('resolves an untyped GitHub number to an issue with an issue URL and useful fields', async () => {
  reply(issue);
  const { items } = await github.fetch(['o/r#2'], ctx());
  expect(items.get('o/r#2')).toEqual({
    title: 'Fix login', url: 'https://github.com/o/r/issues/2', updatedAt: '2026-01-01', state: 'open',
    fields: { 'state reason': '', comments: '0', assignees: 'alice, zoe', labels: 'bug' },
  });
});
it('reports closure reasons, reopening, new comments and edits to the latest comment', async () => {
  reply(issue);
  const before = (await github.fetch(['o/r#2'], ctx())).items.get('o/r#2') as any;
  reply({ ...issue, state: 'CLOSED', stateReason: 'NOT_PLANNED', comments: { totalCount: 1, nodes: [{ updatedAt: '2026-01-02', author: null }] } });
  const closed = (await github.fetch(['o/r#2'], ctx())).items.get('o/r#2') as any;
  expect(describe('o/r#2', before, closed)).toBe('[o/r#2](https://github.com/o/r/issues/2): open → closed; state reason: none → not planned; comments: 0 → 1 latest by unknown at 2026-01-02.');
  reply({ ...issue, stateReason: 'REOPENED', comments: { totalCount: 1, nodes: [{ updatedAt: '2026-01-03', author: { login: 'alice' } }] } });
  const reopened = (await github.fetch(['o/r#2'], ctx())).items.get('o/r#2') as any;
  expect(describe('o/r#2', closed, reopened)).toContain('closed → open; state reason: not planned → reopened');
  expect(describe('o/r#2', closed, reopened)).toContain('latest by alice at 2026-01-03');
  expect(describe('o/r#2', reopened, { ...reopened, updatedAt: '2026-01-04' })).toBeNull();
});
it.each(['OPEN', 'CLOSED', 'MERGED'])('preserves PR snapshot fields for %s PRs', async state => {
  reply({ ...issue, __typename: 'PullRequest', url: 'https://github.com/o/r/pull/1', state,
    mergeable: 'MERGEABLE', isDraft: true, headRefOid: '0123456789abcdef', reviewDecision: null,
    reviews: { totalCount: 1, nodes: [{ state: 'APPROVED', submittedAt: null, author: null }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  });
  expect((await github.fetch(['o/r#1'], ctx())).items.get('o/r#1')).toEqual({
    title: 'Fix login', url: 'https://github.com/o/r/pull/1', updatedAt: '2026-01-01',
    state: state === 'OPEN' ? 'draft' : state.toLowerCase(),
    mergeability: state === 'OPEN' ? 'MERGEABLE' : undefined,
    fields: { commit: '0123456789ab', comments: '0', reviews: '1 (unknown: approved at pending)', 'review decision': '', checks: 'success', assignees: 'alice, zoe', labels: 'bug' },
  });
});
it('returns a retryable error for an inaccessible or missing item', async () => {
  reply(null);
  const error = (await github.fetch(['o/r#2'], ctx())).items.get('o/r#2');
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError).message).toContain('PR/issue access');
});

const pr = (mergeable: string, state = 'OPEN', isDraft = false) => ({
  __typename: 'PullRequest' as const, url: 'https://github.com/o/r/pull/1', title: 'Example', state, isDraft, updatedAt: '2026-01-01', headRefOid: 'abcdef123456', reviewDecision: null as string | null, mergeable,
  assignees: { nodes: [] }, labels: { nodes: [] }, comments: { totalCount: 0, nodes: [] },
  reviews: { totalCount: 0, nodes: [] }, commits: { nodes: [] },
});
async function read(value: ReturnType<typeof pr>) {
  reply(value);
  const { items } = await github.fetch(['o/r#1'], { config: {}, signal: new AbortController().signal });
  return items.get('o/r#1');
}
describeTests('GitHub mergeability', () => {
  it.each(['MERGEABLE', 'CONFLICTING', 'UNKNOWN'])('queries and maps %s independently of checks and review requirements', async mergeable => {
    const value = pr(mergeable);
    value.reviewDecision = 'CHANGES_REQUESTED';
    expect(await read(value)).toMatchObject({ state: 'open', mergeability: mergeable });
    const [command, args] = vi.mocked(execFile).mock.calls[0];
    expect(command).toBe('gh');
    expect((args as string[]).find((arg: string) => arg.startsWith('query='))).toMatch(/\bmergeable\b/);
  });
  it('tracks draft conflicts, but omits mergeability for closed and merged PRs', async () => {
    expect(await read(pr('CONFLICTING', 'OPEN', true))).toMatchObject({ state: 'draft', mergeability: 'CONFLICTING' });
    for (const state of ['CLOSED', 'MERGED']) {
      expect(await read(pr('CONFLICTING', state))).toMatchObject({ state: state.toLowerCase(), mergeability: undefined });
    }
  });
  it('rejects an invalid mergeability response instead of recording a false resolution', async () => {
    await expect(read(pr('BLOCKED'))).rejects.toThrow('Invalid option');
  });
});
