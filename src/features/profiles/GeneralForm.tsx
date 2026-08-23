import { useId, useState } from "react";

import type { ProfileOrganizationDraft } from "../../sidecar/types";
import styles from "./ProfileEditor.module.css";

interface GeneralFormProps {
  name: string;
  nameError: string | null;
  organization: ProfileOrganizationDraft;
  onNameChange: (name: string) => void;
  onOrganizationChange: (organization: ProfileOrganizationDraft) => void;
}

const MAX_TAGS = 10;
const MAX_NOTES = 1500;

export function GeneralForm({
  name,
  nameError,
  organization,
  onNameChange,
  onOrganizationChange,
}: GeneralFormProps) {
  const nameId = useId();
  const notesId = useId();
  const tagId = useId();
  const [tagDraft, setTagDraft] = useState("");

  const addTag = () => {
    const trimmed = tagDraft.trim();
    if (trimmed.length === 0) {
      return;
    }
    // Case-insensitive, matching the sidecar: adding "EU" beside "eu" would be
    // accepted here and silently collapsed on save.
    const folded = trimmed.toLocaleLowerCase();
    if (organization.tags.some((tag) => tag.toLocaleLowerCase() === folded)) {
      setTagDraft("");
      return;
    }
    if (organization.tags.length >= MAX_TAGS) {
      return;
    }
    onOrganizationChange({ ...organization, tags: [...organization.tags, trimmed] });
    setTagDraft("");
  };

  return (
    <div className={styles.general}>
      <label className={styles.stacked} htmlFor={nameId}>
        Name
      </label>
      <input
        id={nameId}
        type="text"
        className={styles.textInput}
        value={name}
        aria-invalid={nameError !== null}
        aria-describedby={nameError === null ? undefined : `${nameId}-error`}
        onChange={(event) => onNameChange(event.target.value)}
      />
      {nameError === null ? null : (
        <p className={styles.error} id={`${nameId}-error`} role="alert">
          {nameError}
        </p>
      )}

      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={organization.favorite}
          onChange={(event) => onOrganizationChange({ ...organization, favorite: event.target.checked })}
        />
        Keep in favorites
      </label>

      <div className={styles.stacked}>
        <label htmlFor={tagId}>Tags</label>
        <ul className={styles.tagList}>
          {organization.tags.map((tag) => (
            <li key={tag} className={styles.tagChip}>
              {tag}
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                onClick={() =>
                  onOrganizationChange({
                    ...organization,
                    tags: organization.tags.filter((candidate) => candidate !== tag),
                  })
                }
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
        <div className={styles.tagEntry}>
          <input
            id={tagId}
            type="text"
            value={tagDraft}
            disabled={organization.tags.length >= MAX_TAGS}
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                // Otherwise Enter submits the surrounding form and saves a
                // profile the user was still typing a tag into.
                event.preventDefault();
                addTag();
              }
            }}
          />
          <button type="button" onClick={addTag} disabled={organization.tags.length >= MAX_TAGS}>
            Add tag
          </button>
        </div>
        <span className={styles.hint}>
          {organization.tags.length} of {MAX_TAGS} tags used.
        </span>
      </div>

      <div className={styles.stacked}>
        <label htmlFor={notesId}>Notes</label>
        <textarea
          id={notesId}
          rows={5}
          maxLength={MAX_NOTES}
          value={organization.notes}
          onChange={(event) => onOrganizationChange({ ...organization, notes: event.target.value })}
        />
        <span className={styles.hint}>
          {organization.notes.length} of {MAX_NOTES} characters. Notes stay on this device unless you sync it.
        </span>
      </div>
    </div>
  );
}
