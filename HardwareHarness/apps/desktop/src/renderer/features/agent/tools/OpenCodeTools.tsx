import {
  AskQuestionInline,
  withOpenCodeToolInteractions
} from "./interactions";
import { ApplyPatchDiff } from "./apply-patch-tool";
import { BashTerminal } from "./bash-tool";
import {
  EditInline,
  GlobInline,
  GrepInline,
  ReadInline,
  WebFetchInline,
  WebSearchInline,
  WriteInline
} from "./inline-tools";
import { ToolFallback } from "../ToolFallback";
import { TestPlanTool as TestPlanToolCard } from "./test-plan-tool";

export const ReadTool = withOpenCodeToolInteractions(ReadInline);
export const EditTool = withOpenCodeToolInteractions(EditInline);
export const WriteTool = withOpenCodeToolInteractions(WriteInline);
export const BashTool = withOpenCodeToolInteractions(BashTerminal);
export const GrepTool = withOpenCodeToolInteractions(GrepInline);
export const GlobTool = withOpenCodeToolInteractions(GlobInline);
export const WebSearchTool = withOpenCodeToolInteractions(WebSearchInline);
export const WebFetchTool = withOpenCodeToolInteractions(WebFetchInline);
export const ApplyPatchTool = withOpenCodeToolInteractions(ApplyPatchDiff);
export const AskQuestionTool = withOpenCodeToolInteractions(AskQuestionInline);
export const FallbackTool = withOpenCodeToolInteractions(ToolFallback);
export const TestPlanTool = withOpenCodeToolInteractions(TestPlanToolCard);
