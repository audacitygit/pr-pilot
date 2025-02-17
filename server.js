// server.js - Automated PR Commenting MVP

import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

app.use(bodyParser.json());

// Webhook Endpoint to Listen for PR Events
app.post('/webhook', async (req, res) => {
    const { action, pull_request, repository } = req.body;

    if (!pull_request) {
        return res.status(400).send('Not a PR event');
    }

    console.log(`Received PR Event: ${action} for ${pull_request.title}`);
    const repoOwner = repository.owner.login;
    const repoName = repository.name;
    const prNumber = pull_request.number;
    const commitId = pull_request.head.sha;

    try {
        // Fetch PR Files
        const filesResponse = await axios.get(
            `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}/files`,
            {
                headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
            }
        );

        const files = filesResponse.data;
        console.log(`Fetched ${files.length} files from PR.`);

        if (files.length > 0) {
            const firstFile = files[0]; // Select first file for inline comment
            await postInlineComment(repoOwner, repoName, prNumber, commitId, firstFile.filename, 1);
        }

        // Post final test comment
        await postFinalComment(repoOwner, repoName, prNumber);

        res.status(200).send('Test comments posted');
    } catch (error) {
        console.error('Error processing PR:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Function to Post an Inline Comment on a PR
async function postInlineComment(owner, repo, prNumber, commitId, path, position) {
    try {
        await axios.post(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
            {
                body: "Test inline comment",
                commit_id: commitId,
                path: path,
                position: position,
            },
            { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
        );
        console.log('Posted test inline comment on PR');
    } catch (error) {
        console.error('Error posting inline comment:', error);
    }
}

// Function to Post a Final Comment on a PR
async function postFinalComment(owner, repo, prNumber) {
    try {
        await axios.post(
            `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
            { body: "Test final comment" },
            { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
        );
        console.log('Posted test final comment on PR');
    } catch (error) {
        console.error('Error posting final comment:', error);
    }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
