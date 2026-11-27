CREATE TRIGGER runs_comparison_same_workflow
BEFORE INSERT ON runs WHEN NEW.comparison_of IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM runs AS parent
    WHERE parent.id=NEW.comparison_of
      AND parent.workspace_id=NEW.workspace_id
      AND parent.workflow_id=NEW.workflow_id
      AND parent.comparison_of IS NULL
      AND parent.version<>NEW.version
      AND parent.input_json=NEW.input_json
  ) THEN RAISE(ABORT,'comparison must use different versions and identical inputs within one workflow') END;
END;
