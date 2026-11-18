'use client';
// 상세 카드 하나가 깨져도 페이지 전체가 죽지 않게 (yoyo0704 요청 11/18). 오류 내용은 화면에 쓰지 않는다
import { Component, type ReactNode } from 'react';

export class CardBoundary extends Component<{ children: ReactNode; label?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: Error) { console.error('card render failed', e.name); }
  render() { return this.state.failed ? <p className="note" role="status">{this.props.label ?? '이 항목'}을 표시하지 못했습니다. 새로고침해 주세요.</p> : this.props.children; }
}
