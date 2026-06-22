// linear.js — Linear GraphQL client used by the service worker.
// Auth uses a Personal API Key passed verbatim in the Authorization header
// (Linear personal keys are NOT prefixed with "Bearer"; OAuth tokens are).

const API_URL = "https://api.linear.app/graphql";

function authHeader(apiKey) {
  // OAuth access tokens are sent as "Bearer <token>"; personal API keys
  // (which start with "lin_api_") are sent raw.
  if (apiKey && apiKey.startsWith("lin_oauth_")) return `Bearer ${apiKey}`;
  return apiKey;
}

export async function gql(apiKey, query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(apiKey),
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    const msg = json.errors.map((e) => e.message).join("; ");
    throw new Error(msg || "Linear API error");
  }
  if (!res.ok) throw new Error(`Linear API HTTP ${res.status}`);
  return json.data;
}

export async function getViewer(apiKey) {
  const data = await gql(
    apiKey,
    `query { viewer { id name email } }`
  );
  return data.viewer;
}

export async function listTeams(apiKey) {
  const data = await gql(
    apiKey,
    `query { teams(first: 250) { nodes { id name key } } }`
  );
  return data.teams.nodes;
}

export async function listProjects(apiKey, teamId) {
  // Projects scoped to a team when teamId given, else all projects.
  if (teamId) {
    const data = await gql(
      apiKey,
      `query($id: String!) {
        team(id: $id) { projects(first: 250) { nodes { id name } } }
      }`,
      { id: teamId }
    );
    return data.team.projects.nodes;
  }
  const data = await gql(
    apiKey,
    `query { projects(first: 250) { nodes { id name } } }`
  );
  return data.projects.nodes;
}

export async function listStates(apiKey, teamId) {
  // Workflow states (a.k.a. statuses) are scoped to a team and ordered by
  // `position`. `type` is one of: triage, backlog, unstarted, started,
  // completed, canceled.
  const data = await gql(
    apiKey,
    `query($id: String!) {
      team(id: $id) {
        states(first: 250) {
          nodes { id name type position color }
        }
      }
    }`,
    { id: teamId }
  );
  return data.team.states.nodes
    .slice()
    .sort((a, b) => a.position - b.position);
}

export async function listLabels(apiKey, teamId) {
  const data = await gql(
    apiKey,
    `query($id: String!) {
      team(id: $id) { labels(first: 250) { nodes { id name color } } }
    }`,
    { id: teamId }
  );
  return data.team.labels.nodes;
}

// Two-step Linear file upload:
//   1) fileUpload mutation -> presigned S3 upload URL + headers + public assetUrl
//   2) PUT the bytes to uploadUrl with the returned headers
// Returns the public assetUrl to embed in markdown / attach.
export async function uploadFile(apiKey, blob, filename) {
  const size = blob.size;
  const contentType = blob.type || "application/octet-stream";
  const data = await gql(
    apiKey,
    `mutation($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success
        uploadFile {
          uploadUrl
          assetUrl
          headers { key value }
        }
      }
    }`,
    { contentType, filename, size }
  );

  const fu = data.fileUpload;
  if (!fu || !fu.success || !fu.uploadFile) {
    throw new Error("Linear refused the file upload request");
  }

  const { uploadUrl, assetUrl, headers } = fu.uploadFile;
  const putHeaders = new Headers();
  putHeaders.set("Content-Type", contentType);
  putHeaders.set("Cache-Control", "public, max-age=31536000");
  for (const h of headers || []) putHeaders.set(h.key, h.value);

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: putHeaders,
    body: blob,
  });
  if (!putRes.ok) {
    throw new Error(`File upload PUT failed (HTTP ${putRes.status})`);
  }
  return assetUrl;
}

export async function createIssue(apiKey, input) {
  const data = await gql(
    apiKey,
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url title }
      }
    }`,
    { input }
  );
  if (!data.issueCreate || !data.issueCreate.success) {
    throw new Error("Linear failed to create the issue");
  }
  return data.issueCreate.issue;
}
