'use client';

/**
 * Agent Builder wizard.
 *
 * Chat-style multi-turn UI that walks the user through 6 BPA-style scoping
 * questions and produces a ClickUp PRD ticket. State machine is enforced
 * server-side (POST /api/agent-builder/*) — see docs/prd-agent-builder.md.
 *
 * UX choices:
 *   - Single scrolling message stream (chat metaphor, not form metaphor)
 *   - Cmd/Ctrl+Enter (or plain Enter without Shift) submits; Shift+Enter newline
 *   - Auto-scroll to bottom on new message
 *   - Disabled composer + spinner while in flight
 *   - "Submit PRD" button appears after Q6 → opens a meta panel for name/tags
 *   - Success state shows the ClickUp link with copy-to-clipboard
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  startAgentBuilderSession,
  submitAgentBuilderTurn,
  finalizeAgentBuilder,
  type AgentBuilderTicketResponse,
} from '@/lib/api';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Sparkles, Send, Loader2, AlertCircle, ArrowLeft, ExternalLink, CheckCircle2, Copy,
} from 'lucide-react';

interface ChatMessage {
  role:           'assistant' | 'user';
  content:        string;
  questionIndex?: number;
}

const PT = (): string =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour:     'numeric',
    minute:   'numeric',
    hour12:   true,
  }).format(new Date());

export default function AgentBuilderWizardPage() {
  const [sessionId, setSessionId]                 = useState<string | null>(null);
  const [questionIndex, setQuestionIndex]         = useState<number>(0);
  const [totalQuestions, setTotalQuestions]       = useState<number>(6);
  const [messages, setMessages]                   = useState<ChatMessage[]>([]);
  const [input, setInput]                         = useState<string>('');
  const [submitting, setSubmitting]               = useState<boolean>(false);
  const [readyToFinalize, setReadyToFinalize]     = useState<boolean>(false);
  const [error, setError]                         = useState<string | null>(null);

  // finalize-meta state
  const [proposedName, setProposedName]           = useState<string>('');
  const [verticalTag, setVerticalTag]             = useState<string>('');
  const [capabilityTag, setCapabilityTag]         = useState<string>('');
  const [finalizing, setFinalizing]               = useState<boolean>(false);
  const [ticket, setTicket]                       = useState<AgentBuilderTicketResponse | null>(null);

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef   = useRef<HTMLDivElement | null>(null);

  // ── Bootstrap session ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await startAgentBuilderSession();
        if (cancelled) return;
        setSessionId(session.sessionId);
        setQuestionIndex(session.questionIndex);
        setTotalQuestions(session.totalQuestions);
        const initial: ChatMessage[] = [];
        if (session.intro) initial.push({ role: 'assistant', content: session.intro });
        initial.push({
          role:          'assistant',
          content:       session.nextQuestion,
          questionIndex: session.questionIndex,
        });
        setMessages(initial);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start session');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Auto-scroll on new messages ─────────────────────────────────────────
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, submitting]);

  // ── Submit handler ──────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!sessionId || !input.trim() || submitting) return;
    const answer = input.trim();
    setInput('');
    setError(null);
    setSubmitting(true);

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: answer, questionIndex },
    ]);

    try {
      const result = await submitAgentBuilderTurn(sessionId, questionIndex, answer);
      if (result.readyToFinalize) {
        setReadyToFinalize(true);
        setMessages((prev) => [
          ...prev,
          {
            role:    'assistant',
            content: 'Got everything I need. Review the PRD details below — set a name and tags, then submit to create the ClickUp ticket.',
          },
        ]);
      } else if (result.nextQuestion && result.nextIndex) {
        setQuestionIndex(result.nextIndex);
        setMessages((prev) => [
          ...prev,
          {
            role:          'assistant',
            content:       result.nextQuestion!,
            questionIndex: result.nextIndex!,
          },
        ]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to submit answer';
      setError(msg);
      // Roll back the user message so they can retry — server didn't accept it.
      setMessages((prev) => prev.slice(0, -1));
      setInput(answer);
    } finally {
      setSubmitting(false);
      // Re-focus composer
      requestAnimationFrame(() => composerRef.current?.focus());
    }
  }, [sessionId, input, questionIndex, submitting]);

  // ── Finalize handler ────────────────────────────────────────────────────
  const handleFinalize = useCallback(async () => {
    if (!sessionId || !proposedName.trim()) return;
    setFinalizing(true);
    setError(null);
    try {
      const result = await finalizeAgentBuilder(sessionId, {
        proposedName:  proposedName.trim(),
        verticalTag:   verticalTag.trim()   || undefined,
        capabilityTag: capabilityTag.trim() || undefined,
      });
      setTicket(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ticket');
    } finally {
      setFinalizing(false);
    }
  }, [sessionId, proposedName, verticalTag, capabilityTag]);

  // ── Composer keybindings ───────────────────────────────────────────────
  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2 h-8 px-2 text-brand-muted">
          <Link href="/agents"><ArrowLeft className="h-4 w-4 mr-1" /> Back to agents</Link>
        </Button>
      </div>

      <div className="flex items-center gap-3 mb-1">
        <Sparkles className="h-6 w-6 text-brand-primary" />
        <h1 className="text-2xl font-bold text-brand-navy">Build a New Agent</h1>
      </div>
      <p className="text-sm text-brand-muted mb-4">
        I&apos;ll ask {totalQuestions} questions to scope this agent, then create a ClickUp PRD engineering can implement from.
      </p>

      {/* Progress */}
      {!ticket && (
        <div className="flex items-center gap-2 mb-4 text-xs text-brand-muted">
          <span>Question</span>
          <Badge variant="secondary" className="font-mono">
            {readyToFinalize ? 'done' : Math.min(questionIndex, totalQuestions)} / {totalQuestions}
          </Badge>
          {readyToFinalize && <span className="text-green-700">— ready to finalize</span>}
        </div>
      )}

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Success state */}
      {ticket && (
        <Card className="border-green-200 bg-green-50/50">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <p className="font-semibold text-brand-navy">PRD ticket created</p>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-brand-navy font-medium">{ticket.title}</p>
            <p className="text-xs text-brand-muted font-mono mt-0.5">{ticket.clickupTaskId}</p>
            <div className="flex flex-wrap gap-1.5 my-3">
              {ticket.tags.map((t) => (
                <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Button asChild>
                <a href={ticket.clickupTaskUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-1.5" /> Open in ClickUp
                </a>
              </Button>
              <Button
                variant="outline"
                onClick={() => navigator.clipboard.writeText(ticket.clickupTaskUrl)}
              >
                <Copy className="h-4 w-4 mr-1.5" /> Copy link
              </Button>
              <Button asChild variant="ghost">
                <Link href="/agents">Back to agents</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Chat stream */}
      {!ticket && (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div
              ref={scrollRef}
              className="h-[480px] overflow-y-auto px-4 py-4 space-y-3 bg-gradient-to-b from-gray-50/50 to-transparent"
            >
              {messages.map((m, i) => (
                <ChatBubble key={i} message={m} />
              ))}
              {submitting && (
                <div className="flex items-center gap-2 text-xs text-brand-muted pl-2 italic">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Elevarus is checking…
                </div>
              )}
            </div>

            {/* Composer */}
            {!readyToFinalize ? (
              <div className="border-t bg-white p-3">
                <div className="flex items-end gap-2">
                  <textarea
                    ref={composerRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onComposerKey}
                    rows={3}
                    placeholder={questionIndex === 0
                      ? 'Loading…'
                      : `Type your answer to question ${questionIndex} (Enter to send, Shift+Enter for newline)`}
                    disabled={submitting || !sessionId}
                    className="flex-1 resize-none border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/30 focus:border-brand-primary/40 disabled:bg-gray-50 disabled:text-gray-400"
                  />
                  <Button
                    onClick={() => void handleSubmit()}
                    disabled={!input.trim() || submitting || !sessionId}
                    className="h-11 shrink-0"
                  >
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-[10px] text-brand-muted mt-1.5 px-0.5">
                  {PT()} PT • Don&apos;t paste tokens, passwords, or customer PII — transcripts are persisted.
                </p>
              </div>
            ) : (
              <FinalizePanel
                proposedName={proposedName}
                setProposedName={setProposedName}
                verticalTag={verticalTag}
                setVerticalTag={setVerticalTag}
                capabilityTag={capabilityTag}
                setCapabilityTag={setCapabilityTag}
                finalizing={finalizing}
                onFinalize={() => void handleFinalize()}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function ChatBubble({ message }: { message: ChatMessage }) {
  const isAssistant = message.role === 'assistant';
  return (
    <div className={`flex ${isAssistant ? 'justify-start' : 'justify-end'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${
          isAssistant
            ? 'bg-white border border-gray-200 text-brand-navy'
            : 'bg-brand-primary text-white'
        }`}
      >
        {isAssistant && message.questionIndex && (
          <div className="text-[10px] uppercase tracking-wide opacity-60 mb-1 font-medium">
            Question {message.questionIndex}
          </div>
        )}
        {message.content}
      </div>
    </div>
  );
}

function FinalizePanel(props: {
  proposedName:    string;
  setProposedName: (v: string) => void;
  verticalTag:     string;
  setVerticalTag:  (v: string) => void;
  capabilityTag:   string;
  setCapabilityTag:(v: string) => void;
  finalizing:      boolean;
  onFinalize:      () => void;
}) {
  return (
    <div className="border-t bg-white p-4 space-y-3">
      <p className="text-sm font-medium text-brand-navy">Finalize the PRD</p>
      <div className="space-y-2">
        <div>
          <label className="text-xs text-brand-muted block mb-1">Agent name <span className="text-red-500">*</span></label>
          <Input
            value={props.proposedName}
            onChange={(e) => props.setProposedName(e.target.value)}
            placeholder="e.g. LinkedIn Ads Reporting"
            disabled={props.finalizing}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-brand-muted block mb-1">Vertical tag (optional)</label>
            <Input
              value={props.verticalTag}
              onChange={(e) => props.setVerticalTag(e.target.value)}
              placeholder="vertical:hvac"
              disabled={props.finalizing}
            />
          </div>
          <div>
            <label className="text-xs text-brand-muted block mb-1">Capability tag (optional)</label>
            <Input
              value={props.capabilityTag}
              onChange={(e) => props.setCapabilityTag(e.target.value)}
              placeholder="capability:reporting"
              disabled={props.finalizing}
            />
          </div>
        </div>
      </div>
      <Button
        onClick={props.onFinalize}
        disabled={!props.proposedName.trim() || props.finalizing}
        className="w-full"
      >
        {props.finalizing ? (
          <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating ClickUp ticket…</>
        ) : (
          <><Send className="h-4 w-4 mr-2" /> Submit PRD to ClickUp</>
        )}
      </Button>
    </div>
  );
}
