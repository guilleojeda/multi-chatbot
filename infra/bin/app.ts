import { App } from "aws-cdk-lib";
import { resolveEnvironment } from "../../config/project.js";
import { SetupStack } from "../lib/setup-stack.js";

const app = new App();
const environment = app.node.tryGetContext("environment") ?? "dev";
const resolvedEnvironment = resolveEnvironment(environment);

new SetupStack(app, "multi-chatbot-setup", resolvedEnvironment);
