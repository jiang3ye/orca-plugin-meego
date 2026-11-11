import { Stack } from 'orca'
import { assert, mount, test } from 'orca/testing'
import { ResultSortControl, resetResultNavigation, WorkItemResults } from './panel-results'
import type { WorkItemSummary } from './protocol'

const table = { label: '工作项列表' }
const tabs = { label: '工作项视图' }

function itemsOf(length: number): WorkItemSummary[] {
  return Array.from({ length }, (_, index) => ({
    id: String(9007199254740992n + BigInt(index)), name: `Item ${index}`, typeKey: 'issue',
    status: 'OPEN', statusState: 'unknown', ownerKeys: [], ownerNames: [], updatedAt: null
  }))
}

test('thousands of long results remain browsable across views with their original IDs and values', async () => {
  const long = '长字段'.repeat(2000)
  const items = itemsOf(6101).map((item, index) => ({
    ...item, name: index === 0 ? 'Open original item' : long,
    ownerNames: [long], status: `${long}${index % 2}`
  }))
  let opened: WorkItemSummary | undefined
  const view = await mount({
    setup: resetResultNavigation,
    default: () => <WorkItemResults items={items} total={items.length} loading={false} hasMore={false}
      disabled={false} emptyText="Empty" onOpen={(item) => { opened = item }} onMore={() => {}} />
  }, { persisted: { plugin: { 'meego.viewMode': 'removed-view', 'meego.loadedSort': 'removed-sort' } } })
  try {
    assert.equal(view.find({ type: 'Table' }), null)
    await view.press({ type: 'ListItem', label: 'Open original item' })
    assert.equal(opened, items[0])
    await view.select(tabs, 'board')
    await view.press({ type: 'ListItem', label: 'Open original item' })
    assert.equal(opened, items[0])
    assert.equal(view.find({ type: 'Table' }), null)
    await view.select(tabs, 'table')
    assert.equal(view.find({ type: 'ListItem' }), null)
    assert.equal(view.rowsOf(table).length, 100)
    assert.deepEqual(view.rowsOf(table).slice(0, 2), ['9007199254740992', '9007199254740993'])
    await view.activateRow(table, '9007199254740993')
    assert.equal(opened, items[1])
    assert.equal(opened?.name, long)
    assert.equal(opened?.ownerNames[0], long)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('table windows open the correct original item and load backend data only at the loaded end', async () => {
  let items = itemsOf(205)
  const original = [...items]
  const extra = { ...original[0], id: '9007199254741197', name: 'Next backend page' }
  let opened: WorkItemSummary | undefined
  const view = await mount({
    setup: resetResultNavigation,
    default: () => <WorkItemResults items={items} total={206} loading={false} hasMore={true}
      disabled={false} emptyText="Empty" onOpen={(item) => { opened = item }} onMore={() => { items = [...items, extra] }} />
  }, { persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await assert.rejects(() => view.loadMore(table), /no more rows/)
    await view.press({ text: '后 100 项' })
    assert.equal(view.rowsOf(table)[0], '9007199254741092')
    await view.activateRow(table, '9007199254741092')
    assert.equal(opened, original[100])
    await assert.rejects(() => view.loadMore(table), /no more rows/)
    await view.press({ text: '后 100 项' })
    assert.deepEqual(view.rowsOf(table), [
      '9007199254741192', '9007199254741193', '9007199254741194', '9007199254741195', '9007199254741196'
    ])
    await view.activateRow(table, '9007199254741196')
    assert.equal(opened, original[204])
    await view.loadMore(table)
    await view.rerender()
    await view.activateRow(table, '9007199254741197')
    assert.equal(opened, extra)
    await view.press({ text: '前 100 项' })
    assert.equal(view.rowsOf(table)[0], '9007199254741092')
    resetResultNavigation()
    await view.rerender()
    assert.equal(view.rowsOf(table)[0], '9007199254740992')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('changing loaded sort resets the table window and sorts full values without replacing the original item', async () => {
  const prefix = 'a'.repeat(401)
  const items = itemsOf(102)
  items[0] = { ...items[0], name: `${prefix}B` }
  items[1] = { ...items[1], name: `${prefix}A` }
  let opened: WorkItemSummary | undefined
  const view = await mount({
    setup: resetResultNavigation,
    default: () => <Stack>
      <ResultSortControl />
      <WorkItemResults items={items} total={items.length} loading={false} hasMore={false} disabled={false}
        emptyText="Empty" onOpen={(item) => { opened = item }} onMore={() => {}} />
    </Stack>
  }, { persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    assert.equal(view.rowsOf(table)[0], '9007199254740992')
    await view.press({ text: '后 100 项' })
    await view.select({ label: '已加载排序' }, 'name')
    assert.equal(view.rowsOf(table)[0], '9007199254740993')
    await view.activateRow(table, '9007199254740993')
    assert.equal(opened, items[1])
    assert.equal(opened?.name, `${prefix}A`)
    await view.select({ label: '已加载排序' }, 'original')
    assert.equal(view.rowsOf(table)[0], '9007199254740992')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})
