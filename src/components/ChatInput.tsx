import React, { useState, useRef } from 'react';
import { ArrowUp } from 'lucide-react';

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  settings: {
    input_placeholder?: string;
  };
}

export const ChatInput: React.FC<ChatInputProps> = ({ onSend, disabled, settings }) => {
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && !disabled) {
      onSend(message);
      setMessage('');
      inputRef.current?.focus();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 bg-white">
      <div className="flex items-center gap-2 rounded-xl
        bg-gray-100 p-2">
        <input
          ref={inputRef}
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={settings.input_placeholder}
          // disabled={disabled}
          className="flex-1 px-1 focus:outline-none bg-transparent"
        />
        <button
          type="submit"
          disabled={disabled || !message.trim()}
          className="p-2 rounded-xl bg-blue-600 text-white disabled:opacity-50 disabled:cursor-default disabled:pointer-events-none disabled:bg-gray-300 hover:bg-blue-700 transition-colors"
        >
          <ArrowUp className="w-4 h-4" />
        </button>
      </div>
    </form>
  );
};