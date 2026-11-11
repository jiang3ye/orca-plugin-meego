import { Box, Button, Input, List, ListItem, Row, Spinner, Stack, Text } from 'orca'

export type MemberChoice = { key: string; name: string }

export interface MemberPickerProps {
  users: MemberChoice[]
  selected: string[]
  query: string
  searching: boolean
  noMatches: boolean
  error: string | null
  disabled: boolean
  description: string
  searchLabel?: string
  candidatesLabel?: string
  currentUserKey?: string
  onQuery: (query: string) => void
  onSearch: () => Promise<void>
  onSelect: (key: string) => void
  onAssignSelf: () => void
}

/** Selection is controlled by authenticated member results and existing assignees. */
export function MemberPicker({ users, selected, query, searching, noMatches, error, disabled, description, searchLabel = '搜索负责人', candidatesLabel = '当前负责人候选成员', currentUserKey, onQuery, onSearch, onSelect, onAssignSelf }: MemberPickerProps) {
  const unnamed = selected.filter((key) => !users.some((user) => user.key === key)).length
  return (
    <Stack gap="sm">
      <Text size="xs" muted>{description}</Text>
      <Row gap="xs" align="center">
        <Box grow shrink>
          <Input label={searchLabel} type="search" placeholder="输入成员姓名，按回车搜索" value={query} maxLength={100} disabled={disabled}
            onChange={onQuery} onSubmit={onSearch} />
        </Box>
        <Button size="sm" variant="outline" disabled={disabled || searching || !query.trim()} onPress={onSearch}>搜索成员</Button>
      </Row>
      {searching ? <Spinner label="正在搜索成员…" /> : null}
      {!searching && noMatches ? <Text size="sm" muted>没有匹配的成员。</Text> : null}
      {error !== null ? <Text size="sm" tone="danger">{error}</Text> : null}
      {users.length > 0 ? (
        <List label={candidatesLabel}>
          {users.map((user) => (
            <ListItem key={user.key} title={user.name} description={selected.includes(user.key) ? '已选择' : undefined}
              icon={selected.includes(user.key) ? 'check' : 'add'} current={selected.includes(user.key)} disabled={disabled}
              onPress={() => onSelect(user.key)} />
          ))}
        </List>
      ) : null}
      {unnamed > 0 ? <Text size="xs" muted>{`${unnamed} 名已选成员的姓名暂不可用，保存时会保留。`}</Text> : null}
      {currentUserKey ? (
        <Row justify="start"><Button size="sm" variant="ghost" disabled={disabled || selected.includes(currentUserKey)} onPress={onAssignSelf}>分配给我</Button></Row>
      ) : null}
    </Stack>
  )
}
