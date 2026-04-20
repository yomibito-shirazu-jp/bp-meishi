import React, { Component, ReactNode } from 'react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', background: '#fee2e2', color: '#991b1b', borderRadius: '8px', margin: '20px', fontFamily: 'sans-serif' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 'bold', marginBottom: '10px' }}>システムエラーが発生しました</h2>
          <p style={{ marginBottom: '10px', fontSize: '0.9rem' }}>
            操作中に予期せぬエラーが発生しましたが、画面を更新（F5）する前に以下の「元の画面に戻る」ボタンをお試しください。<br/>
            画面を更新すると編集中のデータが初期化されてしまう場合があります。
          </p>
          <pre style={{ background: '#f87171', color: 'white', padding: '10px', borderRadius: '4px', overflow: 'auto', fontSize: '0.8rem', marginBottom: '15px' }}>
            {this.state.error?.message}
          </pre>
          <button 
            onClick={this.handleReset}
            style={{ padding: '8px 16px', background: '#dc2626', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            元の画面に戻る（リトライ）
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
