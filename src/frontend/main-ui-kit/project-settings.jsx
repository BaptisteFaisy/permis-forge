/**
 * Project settings (spec §15.2) — the policy grid (classes × zones), the zones,
 * the approver role per rule, the project defaults and the emergency stop.
 *
 * Every write goes through an explicit mutation, so the front-end never touches
 * storage. Class A-15 is flagged as locked in the grid: an agent can never
 * widen it, and the screen says so.
 */
import React, { useState } from 'react';
import ForgeReconciler, {
  Button,
  Heading,
  Inline,
  SectionMessage,
  Select,
  Stack,
  Text,
  Textfield,
  Toggle,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { Empty, ErrorNote, Field, LevelLozenge, Loading, Section, useMutation, useResolver } from './common';

const LEVEL_OPTIONS = [0, 1, 2, 3, 4, 5].map((level) => ({ label: `N${level}`, value: String(level) }));

function NewRuleForm({ data, onSaved }) {
  const [actionClass, setActionClass] = useState('A-08');
  const [zoneId, setZoneId] = useState('');
  const [level, setLevel] = useState('2');
  const [observe, setObserve] = useState(false);
  const [approverRole, setApproverRole] = useState('');
  const mutation = useMutation(onSaved);

  const classOptions = data.catalog.map((entry) => ({
    label: entry.locked ? `${entry.code} — ${entry.name} (locked)` : `${entry.code} — ${entry.name}`,
    value: entry.code,
  }));
  const zoneOptions = [
    { label: 'Any zone', value: '' },
    ...data.zones.map((zone) => ({ label: zone.name, value: zone.id })),
  ];

  const save = () =>
    mutation.run('saveRule', {
      projectId: data.projectId,
      rule: {
        id: `rule-${actionClass.toLowerCase()}${zoneId ? `-${zoneId}` : ''}`,
        scope: 'project',
        projectId: data.projectId,
        actionClass,
        zoneId: zoneId.length > 0 ? zoneId : undefined,
        level: Number(level),
        mode: observe ? 'observe' : 'enforce',
        approverRole: approverRole.trim().length > 0 ? approverRole.trim() : undefined,
      },
    });

  return (
    <Stack space="space.100">
      <Select
        label="Action class"
        options={classOptions}
        value={classOptions.find((option) => option.value === actionClass)}
        onChange={(option) => setActionClass(option && option.value ? option.value : 'A-08')}
      />
      <Select
        label="Zone"
        options={zoneOptions}
        value={zoneOptions.find((option) => option.value === zoneId)}
        onChange={(option) => setZoneId(option && option.value ? option.value : '')}
      />
      <Select
        label="Level"
        options={LEVEL_OPTIONS}
        value={LEVEL_OPTIONS.find((option) => option.value === level)}
        onChange={(option) => setLevel(option && option.value ? option.value : '2')}
      />
      <Toggle
        label="Observe mode (decide and journal, never block)"
        isChecked={observe}
        onChange={() => setObserve(!observe)}
      />
      <Textfield
        label="Approver role"
        value={approverRole}
        onChange={(event) => setApproverRole(event.target.value)}
        placeholder="data-owner, platform, tech-lead…"
      />
      {mutation.error ? <ErrorNote message={mutation.error} /> : null}
      <Button appearance="primary" isDisabled={mutation.busy} onClick={save}>
        Save rule
      </Button>
    </Stack>
  );
}

function KillSwitch({ data, onChanged }) {
  const [reason, setReason] = useState('');
  const mutation = useMutation(onChanged);
  const active = Boolean(data.killSwitch && data.killSwitch.active);

  const toggle = () =>
    mutation.run('toggleProjectKillSwitch', {
      projectId: data.projectId,
      activate: !active,
      reason: reason.trim(),
    });

  return (
    <Stack space="space.100">
      {active ? <SectionMessage appearance="danger" title={data.killSwitchLabels.banner} /> : null}
      <Field label="State" value={active ? `ON — by ${data.killSwitch.by || '?'}` : 'off'} />
      {data.killSwitch && data.killSwitch.reason ? <Field label="Reason" value={data.killSwitch.reason} /> : null}
      <Textfield
        label="Reason (mandatory, both ways)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {mutation.error ? <ErrorNote message={mutation.error} /> : null}
      <Button
        appearance={active ? 'default' : 'danger'}
        isDisabled={mutation.busy || reason.trim().length === 0}
        onClick={toggle}
      >
        {active ? data.killSwitchLabels.lift : data.killSwitchLabels.activate}
      </Button>
    </Stack>
  );
}

const App = () => {
  const { data, error, loading, reload } = useResolver('projectSettings');

  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Empty text="No data." />;

  const removeRule = async (ruleId) => {
    await invoke('deleteRule', { id: ruleId });
    reload();
  };

  return (
    <Stack space="space.300">
      <Heading level="h200">{`${data.title} — ${data.projectId}`}</Heading>

      <Section title="Policy grid">
        {data.rules.length === 0 ? (
          <Empty text="No project rule yet: each class falls back to its catalogue default." />
        ) : (
          <Stack space="space.050">
            {data.rules.map((rule) => (
              <Inline key={rule.id} space="space.100" alignBlock="center">
                <LevelLozenge level={rule.level} label={rule.levelName} />
                <Text weight="bold">{rule.actionClass}</Text>
                <Text>{rule.className}</Text>
                <Text>{rule.zoneId || 'any zone'}</Text>
                <Text>{rule.mode}</Text>
                <Text>{rule.approverRole ? `approver: ${rule.approverRole}` : ''}</Text>
                <Button spacing="compact" appearance="subtle" onClick={() => removeRule(rule.id)}>
                  Delete
                </Button>
              </Inline>
            ))}
          </Stack>
        )}
      </Section>

      <Section title="Add or update a rule">
        <NewRuleForm data={data} onSaved={reload} />
      </Section>

      <Section title="Zones">
        {data.zones.length === 0 ? (
          <Empty text="No zone defined: rules apply to the whole project." />
        ) : (
          <Stack space="space.050">
            {data.zones.map((zone) => (
              <Inline key={zone.id} space="space.100">
                <Text weight="bold">{zone.name}</Text>
                <Text>{zone.pathPatterns.length > 0 ? zone.pathPatterns.join(', ') : 'any path'}</Text>
                <Text>{zone.environment || ''}</Text>
              </Inline>
            ))}
          </Stack>
        )}
      </Section>

      <Section title="Emergency stop">
        <KillSwitch data={data} onChanged={reload} />
      </Section>

      <Section title="Defaults">
        <Field label="Permit duration" value={`${data.settings.defaultPermitTtlMinutes} minutes`} />
        <Field label="Highest level without a ticket" value={`N${data.settings.maxLevelWithoutTicket}`} />
      </Section>
    </Stack>
  );
};

ForgeReconciler.render(<App />);
