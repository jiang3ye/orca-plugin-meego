import { atom, Button, Callout, Heading, Markdown, RelativeTime, Row, Separator, Spinner, Stack, Text, Textarea, plugin, read, set, shell } from 'orca'
import type { WorkItemComment, WorkItemDetail } from './protocol'
import { MAX_COMMENT_LENGTH } from './protocol'
import { connectionChanging } from './panel-connection'
import type { ItemRef } from './panel-handoff'
import { WRITE_REQUEST_OPTIONS, writeResponseLost } from './panel-write'

type CommentTarget = { key: string; ref: ItemRef; url: string }
type CommentPage = { items: WorkItemComment[]; page: number; hasMore: boolean; nextCursor?: string }
type ErrorHandler = (error: unknown) => Promise<void>

const targetAtom = atom<CommentTarget | null>(null)
const openAtom = atom(false)
const commentsAtom = atom<CommentPage | null>(null)
const draftAtom = atom('')
const loadingAtom = atom(false)
const busyAtom = atom(false)
const listErrorAtom = atom<string | null>(null)
const postErrorAtom = atom<string | null>(null)
const postedAtom = atom(false)
// Retain only unresolved writes across detail navigation for this panel instance.
const unverifiedDraftsAtom = atom<ReadonlyMap<string, string>>(new Map())
let listRequest = 0

export function commentBusy(): boolean {
  return read(busyAtom)
}

export function resetComments(detail?: WorkItemDetail, scope: Pick<ItemRef, 'source' | 'expectedUserKey'> = {}): void {
  listRequest += 1
  let target: CommentTarget | null = null
  if (detail) {
    const ref = { ...scope, id: detail.id, typeKey: detail.typeKey, ...(detail.source ? { source: detail.source } : {}) }
    const key = JSON.stringify([ref.source?.baseUrl, ref.source?.projectKey, ref.expectedUserKey, ref.typeKey, String(ref.id)])
    target = { key, ref, url: detail.url }
  }
  set(targetAtom, target)
  set(openAtom, false)
  set(commentsAtom, null)
  set(draftAtom, target ? read(unverifiedDraftsAtom).get(target.key) ?? '' : '')
  set(loadingAtom, false)
  set(listErrorAtom, null)
  set(postErrorAtom, null)
  set(postedAtom, false)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadComments(target: CommentTarget, page: number, onError: ErrorHandler): Promise<void> {
  if (target !== read(targetAtom) || (page > 1 && read(loadingAtom))) return
  const request = ++listRequest
  set(loadingAtom, true)
  set(listErrorAtom, null)
  try {
    const cursor = page > 1 ? read(commentsAtom)?.nextCursor : undefined
    const { comments, hasMore, nextCursor } = await plugin.request('meego.listComments', {
      ...target.ref, page, ...(cursor ? { cursor } : {})
    })
    if (request !== listRequest) return
    const all = page === 1 ? comments : [...(read(commentsAtom)?.items ?? []), ...comments]
    set(commentsAtom, { items: [...new Map(all.map((comment) => [comment.id, comment])).values()], page, hasMore, nextCursor })
  } catch (error) {
    if (request !== listRequest) return
    set(listErrorAtom, messageOf(error))
    await onError(error)
  } finally {
    if (request === listRequest) set(loadingAtom, false)
  }
}

function toggleComments(target: CommentTarget, onError: ErrorHandler): Promise<void> | undefined {
  const open = !read(openAtom)
  set(openAtom, open)
  if (open && read(commentsAtom) === null && !read(loadingAtom)) return loadComments(target, 1, onError)
}

function rememberUnverifiedComment(target: CommentTarget, draft: string): void {
  const drafts = new Map(read(unverifiedDraftsAtom))
  drafts.set(target.key, draft)
  set(unverifiedDraftsAtom, drafts)
  if (target.key === read(targetAtom)?.key) set(draftAtom, draft)
}

function resolveUnverifiedComment(target: CommentTarget, discard: boolean): void {
  if (target !== read(targetAtom)) return
  const drafts = new Map(read(unverifiedDraftsAtom))
  if (!drafts.delete(target.key)) return
  set(unverifiedDraftsAtom, drafts)
  if (discard) set(draftAtom, '')
}

async function submitComment(target: CommentTarget, onError: ErrorHandler): Promise<void> {
  const draft = read(draftAtom)
  const content = draft.trim()
  if (!content || target !== read(targetAtom) || commentBusy() || connectionChanging() || read(unverifiedDraftsAtom).has(target.key)) return
  set(busyAtom, true)
  set(postErrorAtom, null)
  set(postedAtom, false)
  try {
    const result = await plugin.request('meego.addComment', { ...target.ref, content }, WRITE_REQUEST_OPTIONS)
    if ('state' in result) {
      rememberUnverifiedComment(target, draft)
      return
    }
    if (target !== read(targetAtom)) return
    set(draftAtom, '')
    set(postedAtom, true)
    await loadComments(target, 1, onError)
  } catch (error) {
    if (writeResponseLost(error)) {
      rememberUnverifiedComment(target, draft)
      return
    }
    if (target !== read(targetAtom)) return
    set(postErrorAtom, messageOf(error))
    await onError(error)
  } finally {
    set(busyAtom, false)
  }
}

async function openThread(target: CommentTarget): Promise<void> {
  try {
    await shell.openExternal(target.url)
  } catch (error) {
    if (target === read(targetAtom)) set(listErrorAtom, messageOf(error))
  }
}

export function CommentsPanel({ onError }: { onError: ErrorHandler }) {
  const target = read(targetAtom)
  if (target === null) return null
  const open = read(openAtom)
  const page = read(commentsAtom)
  const draft = read(draftAtom)
  const loading = read(loadingAtom)
  const busy = commentBusy()
  const disabled = busy || connectionChanging()
  const unverified = read(unverifiedDraftsAtom).has(target.key)
  const listError = read(listErrorAtom)
  const postError = read(postErrorAtom)
  return (
    <Stack gap="sm">
        <Separator />
        <Row justify="between" align="center" gap="xs" wrap>
          <Heading level={3}>评论{page ? ` · ${page.items.length}${page.hasMore ? '+' : ''}` : ''}</Heading>
          <Button size="sm" variant="ghost" icon={open ? 'collapse' : 'expand'} disabled={connectionChanging()} onPress={() => toggleComments(target, onError)}>
            {open ? '收起评论' : '查看评论'}
          </Button>
          {unverified && !open ? <Text size="sm" muted>有一条评论待核对</Text> : null}
        </Row>
        {open ? (
          <Stack gap="sm">
            {loading ? <Spinner label="加载评论…" /> : null}
            {listError !== null ? (
              <Callout tone="warning" title="评论加载失败">
                <Stack gap="xs">
                  <Text size="sm">{listError}</Text>
                  <Row gap="xs" wrap>
                    <Button size="sm" variant="ghost" disabled={loading || disabled} onPress={() => loadComments(target, 1, onError)}>重试读取评论</Button>
                    {target.url ? <Button size="sm" variant="outline" icon="open-external" onPress={() => openThread(target)}>在飞书项目中查看评论</Button> : null}
                  </Row>
                </Stack>
              </Callout>
            ) : null}
            {page?.items.length === 0 && !loading && listError === null ? <Text size="sm" muted>还没有评论。</Text> : null}
            {page?.items.map((comment) => (
              <Stack key={comment.id} gap="xs">
                <Row gap="xs" wrap>
                  <Text size="sm" weight="semibold">{comment.author || '飞书项目成员'}</Text>
                  {comment.createdAt === null ? null : <RelativeTime at={comment.createdAt} muted />}
                </Row>
                <Markdown content={comment.content} />
              </Stack>
            ))}
            {page && (!unverified || page.hasMore) ? (
              <Row gap="xs" wrap>
                {unverified ? null : <Button size="sm" variant="ghost" icon="refresh" disabled={loading || disabled} onPress={() => loadComments(target, 1, onError)}>刷新评论</Button>}
                {page.hasMore ? <Button size="sm" variant="ghost" disabled={loading || disabled}
                  onPress={() => loadComments(target, page.page + 1, onError)}>加载更多评论</Button> : null}
              </Row>
            ) : null}
            <Textarea label="评论内容" placeholder="写下评论，支持 Markdown…" rows={4} maxLength={MAX_COMMENT_LENGTH}
              value={draft} disabled={disabled || unverified} onChange={(value) => set(draftAtom, value)}
              onSubmit={() => submitComment(target, onError)} />
            {unverified ? (
              <Callout tone="warning" title="评论发布结果待核对">
                <Stack gap="xs">
                  <Text size="sm">草稿已保留。请刷新评论或在飞书项目中确认是否已发布。</Text>
                  <Row gap="xs" wrap>
                    <Button size="sm" variant="outline" icon="refresh" disabled={loading || disabled} onPress={() => loadComments(target, 1, onError)}>刷新评论</Button>
                    {target.url ? <Button size="sm" variant="outline" icon="open-external" onPress={() => openThread(target)}>在飞书项目中核对</Button> : null}
                    <Button size="sm" variant="ghost" disabled={disabled} onPress={() => resolveUnverifiedComment(target, false)}>已核对，尚未发布</Button>
                    <Button size="sm" variant="ghost" disabled={disabled} onPress={() => resolveUnverifiedComment(target, true)}>丢弃草稿</Button>
                  </Row>
                </Stack>
              </Callout>
            ) : null}
            {read(postedAtom) ? <Text size="sm" tone="success">评论已发布</Text> : null}
            {postError !== null ? <Text size="sm" tone="danger">{postError}</Text> : null}
            <Row justify="end">
              <Button size="sm" variant="solid" tone="accent" disabled={disabled || unverified || draft.trim() === ''} onPress={() => submitComment(target, onError)}>
                {busy ? '发布中…' : '发布评论'}
              </Button>
            </Row>
          </Stack>
        ) : null}
    </Stack>
  )
}
