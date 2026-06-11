import express from 'express';
import cors from 'cors';
import { createProject, listProjects, getProject, addWorkflowStep, updateWorkflowStep, getProjectWorkflow, addFeedback, getProjectFeedback } from './db';

const app = express();
app.use(express.json());
app.use(cors());

// Static frontend
app.use(express.static('public'));

// API Routes

// List all projects
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await listProjects();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Get project with workflow
app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const workflow = await getProjectWorkflow(req.params.id);
    const feedback = await getProjectFeedback(req.params.id);

    res.json({
      ...project,
      workflow,
      feedback,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Create project
app.post('/api/projects', async (req, res) => {
  try {
    const { name, description, createdBy } = req.body;

    if (!name || !createdBy) {
      return res.status(400).json({ error: 'Missing name or createdBy' });
    }

    const projectId = await createProject(name, description || '', createdBy);
    const project = await getProject(projectId);

    res.json(project);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Add workflow step
app.post('/api/projects/:id/steps', async (req, res) => {
  try {
    const { actor, action, dmThreadUrl, relayEventId } = req.body;

    if (!actor || !action) {
      return res.status(400).json({ error: 'Missing actor or action' });
    }

    const stepId = await addWorkflowStep(
      req.params.id,
      actor,
      action,
      dmThreadUrl,
      relayEventId
    );

    res.json({ id: stepId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Update workflow step status
app.patch('/api/steps/:id', async (req, res) => {
  try {
    const { status, updatedBy } = req.body;

    if (!status || !updatedBy) {
      return res.status(400).json({ error: 'Missing status or updatedBy' });
    }

    await updateWorkflowStep(req.params.id, status, updatedBy);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Add feedback
app.post('/api/projects/:id/feedback', async (req, res) => {
  try {
    const { eventId, authorPubkey, authorName, content } = req.body;

    if (!eventId || !authorPubkey || !content) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await addFeedback(req.params.id, eventId, authorPubkey, authorName || 'Anonymous', content);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export function startServer(port: number = 3333) {
  app.listen(port, () => {
    console.log(`[Server] Toddy board running on http://localhost:${port}`);
  });
}
