/**
 * The documentation excerpts a chat turn carries.
 *
 * The digest lives in the Studio, not in the deployed Worker: it is loaded on
 * first use, so it is neither in the Studio's first-load closure nor in any app's
 * bundle. A failed load degrades to no excerpts, and the worker's prompt then tells
 * the model to say it is unsure rather than invent an API.
 */
const loadKnowledgeExcerpts = async (question: string): Promise<string[]> => {
    try {
        const { knowledgeExcerpts } = await import("../../../../shared/ai-knowledge");

        return knowledgeExcerpts(question);
    } catch {
        return [];
    }
};

export default loadKnowledgeExcerpts;
