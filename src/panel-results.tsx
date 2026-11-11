import {
  atom, Badge, Box, Button, EmptyState, Grid, List, ListItem, RelativeTime, Row,
  Select, Skeleton, Stack, Tab, Table, Tabs, Text, read, set, type Tone
} from 'orca'
import type { WorkItemSummary } from './protocol'

const viewAtom = atom('meego.viewMode', 'list', { persist: 'plugin' })
const sortAtom = atom('meego.loadedSort', 'original', { persist: 'plugin' })
const tableStartAtom = atom(0)
const PREVIEW_LIMIT = 100
const SORT_OPTIONS = [
  { value: 'original', label: '默认排序' }, { value: 'updated', label: '最近更新' },
  { value: 'name', label: '标题排序' }, { value: 'id', label: '编号排序' }
]

export function resetResultNavigation(): void {
  set(tableStartAtom, 0)
}

export function ResultSortControl({ disabled = false }: { disabled?: boolean }) {
  const sort = read(sortAtom)
  return (
    <Stack gap="xs">
      <Select label="已加载排序" value={SORT_OPTIONS.some((option) => option.value === sort) ? sort : 'original'}
        disabled={disabled} options={SORT_OPTIONS} onChange={(value) => {
          resetResultNavigation()
          set(sortAtom, value)
        }} />
      <Text size="xs" muted>仅排序已加载的工作项。</Text>
    </Stack>
  )
}

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : text
}

export function workItemTone(state: WorkItemSummary['statusState']): Tone {
  return state === 'done' ? 'success' : state === 'in_progress' ? 'accent' : state === 'blocked' ? 'danger' : 'neutral'
}

interface ResultsProps {
  items: WorkItemSummary[]
  total: number
  loading: boolean
  hasMore: boolean
  disabled: boolean
  emptyText: string
  onOpen: (item: WorkItemSummary) => void | Promise<void>
  onMore: () => void | Promise<void>
}

function sortedItems(items: WorkItemSummary[], sort: string): WorkItemSummary[] {
  if (!['updated', 'name', 'id'].includes(sort)) return items
  return [...items].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name, 'zh-CN')
    if (sort === 'id') {
      const left = String(a.id)
      const right = String(b.id)
      return right.length - left.length || right.localeCompare(left)
    }
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  })
}

function ItemRow({ item, disabled, onOpen, showStatus = true }: {
  item: WorkItemSummary
  disabled: boolean
  onOpen: ResultsProps['onOpen']
  showStatus?: boolean
}) {
  return (
    <ListItem title={clip(item.name, 400)} description={`#${item.id} · ${clip(item.ownerNames.join('、') || '未分配', 120)}`}
      disabled={disabled} onPress={() => onOpen(item)}>
      <Row gap="xs" wrap>
        {showStatus ? <Badge tone={workItemTone(item.statusState)}>{clip(item.status || '无状态', 80)}</Badge> : null}
        {item.updatedAt === null ? null : <RelativeTime at={item.updatedAt} muted />}
      </Row>
    </ListItem>
  )
}

function GroupedItems({ items, disabled, onOpen }: Pick<ResultsProps, 'items' | 'disabled' | 'onOpen'>) {
  const groups = new Map<string, WorkItemSummary[]>()
  for (const item of items) {
    const label = item.status || '无状态'
    groups.set(label, [...groups.get(label) ?? [], item])
  }
  return (
    <Grid minItemWidth="sm" gap="sm">
      {[...groups].map(([label, group]) => (
        <Box key={String(group[0].id)} border radius="md" padding="xs" gap="xs">
          <Row justify="between" gap="xs">
            <Badge tone={group.every((item) => item.statusState === group[0].statusState) ? workItemTone(group[0].statusState) : 'neutral'}>{clip(label, 80)}</Badge>
            <Text size="xs" muted>{String(group.length)}</Text>
          </Row>
          <List label={`${clip(label, 80)}工作项 ${group[0].id}`}>
            {group.map((item) => <ItemRow key={String(item.id)} item={item} disabled={disabled} onOpen={onOpen} showStatus={false} />)}
          </List>
        </Box>
      ))}
    </Grid>
  )
}

export function WorkItemResults(props: ResultsProps) {
  const { items, total, loading, hasMore, disabled, emptyText, onOpen, onMore } = props
  const selectedView = read(viewAtom)
  const mode = selectedView === 'table' || selectedView === 'board' ? selectedView : 'list'
  const ordered = sortedItems(items, read(sortAtom))
  const preview = ordered.slice(0, PREVIEW_LIMIT)
  const lastStart = Math.max(0, Math.ceil(ordered.length / PREVIEW_LIMIT) - 1) * PREVIEW_LIMIT
  const start = Math.min(read(tableStartAtom), lastStart)
  const tableItems = ordered.slice(start, start + PREVIEW_LIMIT)
  const longIds = tableItems.some((item) => String(item.id).length > 8)
  const empty = items.length === 0
  return (
    <Stack gap="sm">
      <Tabs label="工作项视图" value={mode} onChange={(value) => set(viewAtom, value)}>
        <Tab value="list" label="列表">
          {mode === 'list' ? loading && empty ? <Skeleton shape="text" lines={4} label="正在加载工作项" /> : empty ? (
            <EmptyState title={emptyText} description="调整筛选条件，或新建一个工作项。" icon="file" />
          ) : (
            <List label="工作项列表">
              {preview.map((item) => <ItemRow key={String(item.id)} item={item} disabled={disabled} onOpen={onOpen} />)}
            </List>
          ) : null}
        </Tab>
        <Tab value="table" label="表格">
          {mode === 'table' ? <Table label="工作项列表"
            columns={[
              { key: 'id', label: 'ID', width: 'sm', hideBelow: longIds ? 'md' : 'sm' },
              { key: 'name', label: '标题', minWidth: 'sm' },
              { key: 'status', label: '状态', width: 'xs', hideBelow: 'sm' },
              { key: 'owners', label: '负责人', width: 'xs', hideBelow: 'md' },
              { key: 'updatedAt', label: '更新时间', width: 'sm', hideBelow: 'md' }
            ]}
            rows={tableItems.map((item) => ({ key: String(item.id), cells: {
              id: String(item.id), name: clip(item.name, 400), status: clip(item.status || '—', 80),
              owners: clip(item.ownerNames.join('、') || '—', 120),
              updatedAt: item.updatedAt === null ? '—' : { type: 'relative', at: item.updatedAt }
            } }))}
            hasMore={hasMore && start === lastStart} loading={loading} emptyText={emptyText}
            onRowAction={({ key }) => {
              const item = tableItems.find((entry) => String(entry.id) === key)
              if (!disabled && item) return onOpen(item)
            }}
            onLoadMore={() => { if (!disabled && !loading && start === lastStart && hasMore) return onMore() }} /> : null}
        </Tab>
        <Tab value="board" label="按状态">
          {mode === 'board' ? loading && empty ? <Skeleton shape="text" lines={4} label="正在加载状态分组" /> : empty ? (
            <EmptyState title={emptyText} description="调整筛选条件，或新建一个工作项。" icon="layers" />
          ) : <GroupedItems items={preview} disabled={disabled} onOpen={onOpen} /> : null}
        </Tab>
      </Tabs>
      {mode === 'table' && ordered.length > PREVIEW_LIMIT ? (
        <Row gap="sm" align="center" justify="between" wrap>
          <Button size="sm" variant="ghost" disabled={disabled || loading || start === 0}
            onPress={() => set(tableStartAtom, start - PREVIEW_LIMIT)}>前 100 项</Button>
          <Text size="xs" muted>{`${start + 1}–${start + tableItems.length} / ${ordered.length} 项已加载`}</Text>
          <Button size="sm" variant="ghost" disabled={disabled || loading || start === lastStart}
            onPress={() => set(tableStartAtom, start + PREVIEW_LIMIT)}>后 100 项</Button>
        </Row>
      ) : null}
      {hasMore ? <Text size="xs" muted>{`已加载 ${items.length} / ${total} 项`}</Text> : null}
      {mode === 'board' ? <Text size="xs" muted>按已加载工作项的原始状态分组。</Text> : null}
      {mode !== 'table' && items.length > PREVIEW_LIMIT ? (
        <Stack gap="xs">
          <Text size="xs" muted>{`当前展示前 ${PREVIEW_LIMIT} 项。表格可分段浏览全部已加载工作项。`}</Text>
          <Button size="sm" variant="ghost" onPress={() => set(viewAtom, 'table')}>切换表格浏览全部</Button>
        </Stack>
      ) : mode !== 'table' && hasMore ? (
        <Row justify="center"><Button size="sm" variant="ghost" disabled={disabled || loading} onPress={onMore}>{loading ? '正在加载…' : '加载更多工作项'}</Button></Row>
      ) : null}
    </Stack>
  )
}
