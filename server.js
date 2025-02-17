import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.use(bodyParser.json());

app.get("/health", (req, res) => {
    return res.json({ status: "healthy" })
})

// Webhook Endpoint to Listen for PR Events
app.post("/webhook", async (req, res) => {
    const { action, pull_request, repository } = req.body;

    if (!pull_request) {
        return res.status(400).send("Not a PR event");
    }

    console.log(`Received PR Event: ${action} for ${pull_request.title}`);
    const repoOwner = repository.owner.login;
    const repoName = repository.name;
    const prNumber = pull_request.number;
    const commitId = pull_request.head.sha;

    try {
        // Fetch PR Files from GitHub
        const filesResponse = await axios.get(
            `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}/files`,
            {
                headers: { Authorization: `token ${GITHUB_TOKEN}` },
            }
        );

        const files = filesResponse.data;
        console.log(`Fetched ${files.length} files from PR.`);

        if (files.length > 0) {
            // Send PR files to AI for analysis
            const aiReview = await sendCodeToAI(files);

            // Log AI response
            console.log("AI Review Response:", aiReview);
        }

        res.status(200).send("AI Review Processed");
    } catch (error) {
        console.error("Error processing PR:", error);
        res.status(500).send("Internal Server Error");
    }
});

// Function to Send PR Files to AI for Review
async function sendCodeToAI(files) {
    try {
        // Convert file diffs to a formatted string
        const formattedFiles = files
            .map((file) => `File: ${file.filename}\nChanges:\n${file.patch}`)
            .join("\n\n");

        // Send request to OpenAI API
        const response = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [
                { role: "system", content: "You are a code reviewer. Provide insights and improvements." },
                { role: "user", content: `Please review the following code changes:\n\n${formattedFiles}` },
            ],
            max_tokens: 500,
        });

        return response.choices[0].message.content;
    } catch (error) {
        console.error("Error communicating with OpenAI:", error);
        return "AI Review Failed";
    }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
