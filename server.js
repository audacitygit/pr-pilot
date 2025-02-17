import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.use(bodyParser.json());

app.get("/health", (req, res) => {
    return res.json({ status: "healthy" });
});

// Webhook Endpoint to Listen for PR Events
app.post("/webhook", async (req, res) => {
    const { action, pull_request, repository } = req.body;
    console.log({ action })
    if (action === "closed") {
        return res.status(400).send("Not a PR open event");
    }

    console.log(`Received PR Open Event for ${pull_request.title}`);
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

            // Post inline comments based on AI review
            await postAIInlineComments(repoOwner, repoName, prNumber, commitId, files, aiReview);

            // Post final summary comment
            await postFinalComment(repoOwner, repoName, prNumber, aiReview);
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

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `You are a code reviewer. Only point out errors, inefficiencies, or improvements. 
                        Do not provide positive feedback. Format your response strictly as follows:
                        
                        File: <filename>
                        Line: <line number>
                        Issue: <brief issue description>
            
                        Do not include bullet points, numbers, or unnecessary formatting.`
                },
                { role: "user", content: `Review the following code changes and provide feedback only for errors or improvements:\n\n${formattedFiles}` },
            ],
            max_tokens: 500,
        });


        return response.choices[0].message.content;
    } catch (error) {
        console.error("Error communicating with OpenAI:", error);
        return "AI Review Failed";
    }
}

async function postAIInlineComments(owner, repo, prNumber, commitId, files, aiReview) {
    try {
        console.log("Processing AI review response...");
        const reviewLines = aiReview.split("\n\n");
        let lastKnownFile = null;

        for (const review of reviewLines) {
            try {
                console.log("Processing review:", review);

                // Adjust regex to be more flexible
                const match = review.match(/(?:File:\s*(.*?)\s*)?\n?Line:\s*(\d+)\s*Issue:\s*(.*)/s);
                console.log({ match });

                if (match) {
                    let [, path, line, issue] = match.map(x => x ? x.trim() : null);

                    // If AI did not specify a file, use the last known file
                    if (!path) {
                        if (!lastKnownFile) {
                            console.warn("⚠️ Skipping comment because no file was detected in AI output:", review);
                            continue;
                        }
                        path = lastKnownFile;
                    } else {
                        lastKnownFile = path; // Update last known file
                    }

                    console.log(`Posting inline comment on ${path} at line ${line}: ${issue}`);
                    await postInlineComment(owner, repo, prNumber, commitId, path, parseInt(line, 10), issue);
                } else {
                    console.warn("⚠️ Review did not match expected format. AI may not be returning structured data:", review);
                }
            } catch (error) {
                console.error("❌ Error processing individual review line:", review, error);
            }
        }
    } catch (error) {
        console.error("❌ Error in postAIInlineComments function:", error);
    }
}


async function postInlineComment(owner, repo, prNumber, commitId, path, position, comment) {
    console.log("postinlinecomment", { commitId, path, position, owner, repo });

    try {
        // Find correct diff position for the line
        const diffPosition = await getGitHubDiffPosition(owner, repo, prNumber, path, position);
        if (diffPosition === null) {
            console.warn(`⚠️ Skipping comment because line ${position} in ${path} was not found in the diff.`);
            return;
        }

        await axios.post(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
            {
                body: comment,
                commit_id: commitId,
                path: path,
                position: diffPosition,
            },
            { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
        );
        console.log(`✅ Posted inline comment on ${path} at diff line ${diffPosition}`);
    } catch (error) {
        console.error("❌ Error posting inline comment:", error);
    }
}

async function getGitHubDiffPosition(owner, repo, prNumber, path, line) {
    try {
        const response = await axios.get(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
            {
                headers: { Authorization: `token ${GITHUB_TOKEN}` }
            }
        );

        const fileData = response.data.find(f => f.filename === path);
        if (!fileData || !fileData.patch) {
            console.warn(`⚠️ Could not find diff for ${path}`);
            return null;
        }

        const patchLines = fileData.patch.split("\n");
        let diffPosition = 0;
        let realLineNumber = 0;

        for (const patchLine of patchLines) {
            if (patchLine.startsWith("@@")) {
                // Parse hunk header like @@ -10,7 +10,7 @@
                const match = patchLine.match(/\+(\d+)/);
                if (match) {
                    realLineNumber = parseInt(match[1], 10) - 1;
                }
            } else {
                if (!patchLine.startsWith("-")) {
                    realLineNumber++;
                }
                if (realLineNumber === line) {
                    return diffPosition;
                }
                diffPosition++;
            }
        }

        return null;
    } catch (error) {
        console.error("❌ Error getting diff position:", error);
        return null;
    }
}

// Function to Post a Final Summary Comment on a PR
async function postFinalComment(owner, repo, prNumber, aiReview) {
    try {
        const summaryResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Summarize the key issues found in the PR as a bullet-point list." },
                { role: "user", content: `Summarize the following code review findings as a concise bullet-point list:\n\n${aiReview}` },
            ],
            max_tokens: 100,
        });

        const summary = `### AI Review Summary:\n\n- ${summaryResponse.choices[0].message.content.replace(/\n/g, "\n- ")}`;

        await axios.post(
            `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
            { body: summary },
            { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
        );
        console.log("Posted final summary comment on PR");
    } catch (error) {
        console.error("Error posting final summary comment:", error);
    }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
