import { useEffect, useState } from "react";
import { api } from "./api";
export function TeamPanel({
  eventId,
  notify,
}: {
  eventId: string;
  notify: (message: string) => void;
}) {
  const [team, setTeam] = useState<{ members: any[]; invitations: any[] }>({
    members: [],
    invitations: [],
  });
  const [busy, setBusy] = useState(false);
  const load = () =>
    api
      .team(eventId)
      .then(setTeam)
      .catch((e) => notify(e.message));
  useEffect(() => {
    load();
  }, [eventId]);
  const remove = async (id: string, invitation = false) => {
    if (
      !confirm(
        invitation
          ? "Revoke this pending invitation?"
          : "Remove this collaborator’s event access?",
      )
    )
      return;
    setBusy(true);
    try {
      if (invitation) await api.revokeInvite(eventId, id);
      else await api.removeMember(eventId, id);
      await load();
      notify("Access removed");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Unable to remove access");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="team-panel">
      <h3>Team access</h3>
      <button className="btn ghost" onClick={load}>
        Refresh team
      </button>
      {team.members.map((member) => (
        <div key={member.id}>
          <span>
            <b>{member.name}</b> · {member.email} · {member.role}
          </span>
          {member.role !== "owner" && (
            <button disabled={busy} onClick={() => remove(member.id)}>
              Remove
            </button>
          )}
        </div>
      ))}
      {team.invitations.map((invite) => (
        <div key={invite.id}>
          <span>
            {invite.email} · {invite.role} · pending until{" "}
            {new Date(invite.expires_at).toLocaleDateString()}
          </span>
          <button disabled={busy} onClick={() => remove(invite.id, true)}>
            Revoke
          </button>
        </div>
      ))}
    </section>
  );
}
