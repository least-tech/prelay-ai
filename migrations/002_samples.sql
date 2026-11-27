CREATE UNIQUE INDEX one_fictional_workflow_per_workspace ON workflows(workspace_id) WHERE fictional=1;
