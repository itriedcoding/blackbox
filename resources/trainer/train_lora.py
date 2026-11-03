#!/usr/bin/env python3
"""Real LoRA supervised fine-tuning for Blackbox.

Trains a PEFT LoRA adapter with plain PyTorch (no cloud, no services) on a
JSONL dataset produced by Blackbox. CPU training is supported; it is slow by
nature, which is why progress and loss are printed line by line.

Dataset lines are either:
    {"messages": [{"role": "user", ...}, {"role": "assistant", ...}]}
or
    {"text": "..."}            (completion-only)

Output: a PEFT adapter directory (adapter_config.json + adapter_model.safetensors)
that convert_lora_to_gguf.py can turn into a GGUF adapter.
"""

import argparse
import json
import math
import os
import random
import sys

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer


def read_jsonl(path):
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise SystemExit(f"line {line_number}: invalid JSON ({error})")
    if not rows:
        raise SystemExit("dataset is empty")
    return rows


def encode_chat(tokenizer, messages, max_len):
    """Tokenise a chat example, masking the prompt so only the reply is learned."""
    prompt_messages = messages[:-1]
    reply = messages[-1]["content"]
    try:
        prompt_text = tokenizer.apply_chat_template(
            prompt_messages, tokenize=False, add_generation_prompt=True
        )
    except Exception:
        prompt_text = "".join(f"{m['role']}: {m['content']}\n" for m in prompt_messages) + "assistant: "
    prompt_ids = tokenizer(prompt_text, add_special_tokens=False)["input_ids"]
    reply_ids = tokenizer(reply, add_special_tokens=False)["input_ids"] + [tokenizer.eos_token_id]
    input_ids = (prompt_ids + reply_ids)[:max_len]
    labels = ([-100] * len(prompt_ids) + reply_ids)[:max_len]
    return input_ids, labels


def encode_text(tokenizer, text, max_len):
    ids = tokenizer(text, add_special_tokens=True)["input_ids"][:max_len]
    return ids, list(ids)


def collate(batch, pad_id):
    width = max(len(ids) for ids, _ in batch)
    input_ids, labels, attention = [], [], []
    for ids, label in batch:
        pad = width - len(ids)
        input_ids.append(ids + [pad_id] * pad)
        labels.append(label + [-100] * pad)
        attention.append([1] * len(ids) + [0] * pad)
    return (
        torch.tensor(input_ids, dtype=torch.long),
        torch.tensor(labels, dtype=torch.long),
        torch.tensor(attention, dtype=torch.long),
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Hugging Face repo id or local directory")
    parser.add_argument("--data", required=True, help="normalised JSONL dataset")
    parser.add_argument("--out", required=True, help="adapter output directory")
    parser.add_argument("--rank", type=int, default=8)
    parser.add_argument("--alpha", type=int, default=16)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--max-steps", type=int, default=0)
    parser.add_argument("--seq-len", type=int, default=512)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--seed", type=int, default=1337)
    parser.add_argument("--threads", type=int, default=0)
    args = parser.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    if args.threads > 0:
        torch.set_num_threads(args.threads)

    rows = read_jsonl(args.data)
    is_chat = "messages" in rows[0]
    print(json.dumps({"event": "dataset", "rows": len(rows), "format": "chat" if is_chat else "text"}), flush=True)

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    dtype = torch.float32
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=dtype,
        low_cpu_mem_usage=True,
        trust_remote_code=False,
    )
    model.config.use_cache = False
    if hasattr(model, "gradient_checkpointing_enable"):
        model.gradient_checkpointing_enable()
    if hasattr(model, "enable_input_require_grads"):
        model.enable_input_require_grads()

    from peft import LoraConfig, get_peft_model

    targets = None
    for candidate in (
        ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        ["c_attn", "c_proj", "c_fc"],
    ):
        if any(any(name.endswith(module) for name in dict(model.named_modules())) for module in candidate):
            targets = candidate
            break
    if targets is None:
        raise SystemExit("could not infer LoRA target modules for this architecture")

    lora = LoraConfig(
        r=args.rank,
        lora_alpha=args.alpha,
        lora_dropout=0.0,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=targets,
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()
    model.train()

    examples = []
    for row in rows:
        if is_chat:
            messages = row.get("messages") or []
            if not messages or messages[-1].get("role") != "assistant":
                continue
            ids, labels = encode_chat(tokenizer, messages, args.seq_len)
        else:
            ids, labels = encode_text(tokenizer, row.get("text", ""), args.seq_len)
        if len(ids) >= 8:
            examples.append((ids, labels))
    if not examples:
        raise SystemExit("no example produced at least 8 tokens")

    steps_per_epoch = max(1, math.ceil(len(examples) / (args.batch_size * args.grad_accum)))
    total_steps = args.max_steps if args.max_steps > 0 else max(1, int(steps_per_epoch * args.epochs))
    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr)
    print(json.dumps({"event": "start", "steps": total_steps, "examples": len(examples)}), flush=True)

    step = 0
    running = 0.0
    while step < total_steps:
        random.shuffle(examples)
        for index in range(0, len(examples), args.batch_size):
            if step >= total_steps:
                break
            batch = examples[index : index + args.batch_size]
            input_ids, labels, attention = collate(batch, tokenizer.pad_token_id)
            outputs = model(input_ids=input_ids, attention_mask=attention, labels=labels)
            loss = outputs.loss / args.grad_accum
            loss.backward()
            running += float(outputs.loss.detach())
            if (step + 1) % args.grad_accum == 0:
                torch.nn.utils.clip_grad_norm_(
                    [p for p in model.parameters() if p.requires_grad], 1.0
                )
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
            step += 1
            if step % max(1, args.grad_accum) == 0 or step == total_steps:
                average = running / max(1, args.grad_accum)
                running = 0.0
                print(
                    json.dumps(
                        {"event": "step", "step": step, "steps": total_steps, "loss": round(average, 4)}
                    ),
                    flush=True,
                )

    os.makedirs(args.out, exist_ok=True)
    model.save_pretrained(args.out)
    tokenizer.save_pretrained(args.out)
    print(json.dumps({"event": "done", "adapter": args.out}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
